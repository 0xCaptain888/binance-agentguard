// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// PUBLIC TESTNET ENGINEERING FIXTURE. No real dollars, market price or external liquidity.
contract ControlledToken is ERC20 {
    uint8 private immutable precision;
    constructor(string memory symbol_, uint8 decimals_, address owner_, address router_)
        ERC20(symbol_, symbol_)
    {
        precision = decimals_;
        _mint(owner_, 100 * 10 ** decimals_);
        _mint(router_, 10000 * 10 ** decimals_);
    }
    function decimals() public view override returns (uint8) { return precision; }
}

contract ControlledFeed {
    address public immutable owner;
    uint8 public constant decimals = 8;
    uint80 public roundId;
    uint256 public updatedAt;
    constructor(address owner_) { owner = owner_; roundId = 1; updatedAt = block.timestamp; }
    function refresh() external {
        require(msg.sender == owner, "owner only");
        roundId += 1; updatedAt = block.timestamp;
    }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, 100000000, updatedAt, updatedAt, roundId);
    }
}

contract ControlledRouter {
    using SafeERC20 for IERC20;
    address public immutable environment;
    address public token0;
    address public token1;
    constructor() { environment = msg.sender; }
    function controlledTestEnvironment() external pure returns (bool) { return true; }
    function initialize(address token0_, address token1_) external {
        require(msg.sender == environment && token0 == address(0), "already initialized or unauthorized");
        token0 = token0_; token1 = token1_;
    }
    function getAmountsOut(uint256 amountIn, address[] calldata path) public view returns (uint256[] memory amounts) {
        require(path.length == 2 && ((path[0] == token0 && path[1] == token1) ||
            (path[0] == token1 && path[1] == token0)), "test pair only");
        amounts = new uint256[](2); amounts[0] = amountIn;
        // Synthetic fixed 1:1 value, not a DEX price. Precision intentionally differs.
        amounts[1] = amountIn * (10 ** ERC20(path[1]).decimals()) / (10 ** ERC20(path[0]).decimals());
        require(amounts[1] > 0 && IERC20(path[1]).balanceOf(address(this)) >= amounts[1], "test reserve exhausted");
    }
    function swapExactTokensForTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts)
    {
        require(deadline >= block.timestamp && to != address(0), "invalid destination or deadline");
        amounts = getAmountsOut(amountIn, path);
        require(amounts[1] >= minOut, "slippage");
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).safeTransfer(to, amounts[1]);
    }
}

contract ControlledEnvironment {
    address public immutable owner;
    ControlledToken public immutable token0;
    ControlledToken public immutable token1;
    ControlledFeed public immutable feed0;
    ControlledFeed public immutable feed1;
    ControlledRouter public immutable router;
    bytes32 public constant fixtureSchema = keccak256("AGENTGUARD_CONTROLLED_TESTNET_V1");
    constructor(address owner_) {
        require(block.chainid == 97, "BSC testnet only");
        require(owner_ != address(0), "owner required");
        owner = owner_;
        router = new ControlledRouter();
        token0 = new ControlledToken("AG-TEST-A", 18, owner_, address(router));
        token1 = new ControlledToken("AG-TEST-B", 6, owner_, address(router));
        router.initialize(address(token0), address(token1));
        feed0 = new ControlledFeed(owner_); feed1 = new ControlledFeed(owner_);
    }
}
