// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IV2Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory);
}

/// @notice Unaudited, per-user reference vault. The operator cannot withdraw, change policy,
/// change assets/router/feeds, or send swap output anywhere except this vault.
/// @dev Standard ERC20s only. Rebasing and fee-on-transfer assets are unsupported.
contract AgentGuardVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable owner;
    address public immutable operator;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    IPriceFeed public immutable feed0;
    IPriceFeed public immutable feed1;
    IV2Router public immutable router;
    uint256 public immutable unit0;
    uint256 public immutable unit1;
    uint256 private immutable feedUnit0;
    uint256 private immutable feedUnit1;

    struct Policy {
        uint256 maxActionUsd; // 18 decimals, both directions consume the same budget
        uint256 maxDailyUsd;
        uint16 targetToken0Bps;
        uint16 maxSlippageBps;
        uint32 cooldownSeconds;
        uint32 maxOracleAge;
    }
    Policy public policy;
    bool public paused;
    uint256 public spentTodayUsd;
    uint256 public spendDay;
    uint256 public lastExecutionAt;
    uint256 public executionNonce;

    error Unauthorized();
    error InvalidConfiguration();
    error Paused();
    error InvalidQuote();
    error StaleOracle();
    error BudgetExceeded();
    error Cooldown();
    error WrongDirection();
    error BalanceMismatch();
    error DriftNotImproved();

    event PolicyUpdated(bytes32 policyHash);
    event PauseChanged(bool paused);
    event Deposited(address indexed sender, address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount);
    event Rebalanced(bytes32 indexed planId, uint256 indexed nonce, address indexed tokenIn,
        uint256 amountIn, uint256 amountOut, uint256 notionalUsd, uint256 driftBeforeBps, uint256 driftAfterBps);

    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }

    constructor(address owner_, address operator_, address token0_, address token1_, address router_,
        address feed0_, address feed1_, Policy memory policy_) {
        if (owner_ == address(0) || operator_ == address(0) || token0_ == token1_ ||
            token0_.code.length == 0 || token1_.code.length == 0 || router_.code.length == 0 ||
            feed0_.code.length == 0 || feed1_.code.length == 0) revert InvalidConfiguration();
        owner = owner_; operator = operator_;
        token0 = IERC20(token0_); token1 = IERC20(token1_);
        feed0 = IPriceFeed(feed0_); feed1 = IPriceFeed(feed1_); router = IV2Router(router_);
        uint8 d0 = IERC20Metadata(token0_).decimals(); uint8 d1 = IERC20Metadata(token1_).decimals();
        uint8 f0 = IPriceFeed(feed0_).decimals(); uint8 f1 = IPriceFeed(feed1_).decimals();
        if (d0 > 18 || d1 > 18 || f0 > 18 || f1 > 18) revert InvalidConfiguration();
        unit0 = 10 ** d0; unit1 = 10 ** d1; feedUnit0 = 10 ** f0; feedUnit1 = 10 ** f1;
        _setPolicy(policy_);
    }

    function _setPolicy(Policy memory next) private {
        if (next.maxActionUsd == 0 || next.maxDailyUsd < next.maxActionUsd ||
            next.targetToken0Bps == 0 || next.targetToken0Bps >= 10000 ||
            next.maxSlippageBps > 500 || next.maxOracleAge == 0) revert InvalidConfiguration();
        policy = next;
        emit PolicyUpdated(keccak256(abi.encode(next)));
    }

    function setPolicy(Policy calldata next) external onlyOwner { _setPolicy(next); }
    function setPaused(bool next) external onlyOwner { paused = next; emit PauseChanged(next); }

    function deposit(bool isToken0, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidConfiguration();
        IERC20 token = isToken0 ? token0 : token1;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert BalanceMismatch();
        emit Deposited(msg.sender, address(token), amount);
    }

    function withdraw(bool isToken0, uint256 amount) external onlyOwner nonReentrant {
        IERC20 token = isToken0 ? token0 : token1;
        token.safeTransfer(owner, amount);
        emit Withdrawn(address(token), amount);
    }

    function _price(IPriceFeed feed, uint256 feedUnit) private view returns (uint256) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp ||
            block.timestamp - updatedAt > policy.maxOracleAge || answeredInRound < roundId) revert StaleOracle();
        uint256 price = Math.mulDiv(uint256(answer), 1e18, feedUnit);
        if (price == 0) revert StaleOracle();
        return price;
    }

    function prices() public view returns (uint256 price0, uint256 price1) {
        return (_price(feed0, feedUnit0), _price(feed1, feedUnit1));
    }

    function _drift(uint256 b0, uint256 b1, uint256 p0, uint256 p1) private view returns (uint256 drift, uint256 share) {
        uint256 v0 = Math.mulDiv(b0, p0, unit0); uint256 v1 = Math.mulDiv(b1, p1, unit1);
        if (v0 + v1 == 0) revert InvalidConfiguration();
        share = Math.mulDiv(v0, 10000, v0 + v1);
        uint256 target = policy.targetToken0Bps;
        drift = share > target ? share - target : target - share;
    }

    function rebalance(bool sellToken0, uint256 amountIn, uint256 minAmountOut, uint256 deadline,
        uint256 expectedNonce, bytes32 planId) external nonReentrant {
        if (msg.sender != owner && msg.sender != operator) revert Unauthorized();
        if (paused) revert Paused();
        if (planId == bytes32(0) || amountIn == 0 || minAmountOut == 0 || expectedNonce != executionNonce ||
            deadline < block.timestamp || deadline > block.timestamp + 120) revert InvalidQuote();
        if (lastExecutionAt != 0 && block.timestamp < lastExecutionAt + policy.cooldownSeconds) revert Cooldown();
        (uint256 p0, uint256 p1) = prices();
        uint256 b0 = token0.balanceOf(address(this)); uint256 b1 = token1.balanceOf(address(this));
        (uint256 driftBefore, uint256 share) = _drift(b0, b1, p0, p1);
        if (sellToken0 ? share <= policy.targetToken0Bps : share >= policy.targetToken0Bps) revert WrongDirection();
        uint256 notional = Math.mulDiv(amountIn, sellToken0 ? p0 : p1, sellToken0 ? unit0 : unit1);
        uint256 day = block.timestamp / 1 days;
        uint256 alreadySpent = spendDay == day ? spentTodayUsd : 0;
        if (notional == 0 || notional > policy.maxActionUsd || alreadySpent + notional > policy.maxDailyUsd) revert BudgetExceeded();
        uint256 fairOut = Math.mulDiv(notional, sellToken0 ? unit1 : unit0, sellToken0 ? p1 : p0);
        uint256 oracleFloor = Math.mulDiv(fairOut, 10000 - policy.maxSlippageBps, 10000, Math.Rounding.Ceil);
        if (minAmountOut < oracleFloor) revert InvalidQuote();
        IERC20 input = sellToken0 ? token0 : token1; IERC20 output = sellToken0 ? token1 : token0;
        uint256 inBefore = sellToken0 ? b0 : b1; uint256 outBefore = sellToken0 ? b1 : b0;
        address[] memory path = new address[](2); path[0] = address(input); path[1] = address(output);
        // Effects precede the external router call. Reverts roll back budgets and nonce.
        spentTodayUsd = alreadySpent + notional; spendDay = day;
        lastExecutionAt = block.timestamp; executionNonce++;
        input.forceApprove(address(router), amountIn);
        router.swapExactTokensForTokens(amountIn, minAmountOut, path, address(this), deadline);
        input.forceApprove(address(router), 0);
        uint256 inAfter = input.balanceOf(address(this)); uint256 outAfter = output.balanceOf(address(this));
        if (inBefore < inAfter || inBefore - inAfter != amountIn || outAfter < outBefore || outAfter - outBefore < minAmountOut)
            revert BalanceMismatch();
        uint256 amountOut = outAfter - outBefore;
        (uint256 driftAfter,) = _drift(token0.balanceOf(address(this)), token1.balanceOf(address(this)), p0, p1);
        if (driftAfter >= driftBefore) revert DriftNotImproved();
        emit Rebalanced(planId, expectedNonce, address(input), amountIn, amountOut, notional, driftBefore, driftAfter);
    }
}
