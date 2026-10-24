// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// LOCAL TEST FIXTURES ONLY: not real USD, price data, market liquidity, or campaign proof.
contract TestToken is ERC20 {
    uint8 private immutable tokenDecimals;
    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) { tokenDecimals = decimals_; }
    function decimals() public view override returns (uint8) { return tokenDecimals; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract TestFeed {
    uint8 public constant decimals = 8;
    int256 public answer;
    uint256 public updatedAt;
    constructor(int256 answer_) { set(answer_, block.timestamp); }
    function set(int256 answer_, uint256 updatedAt_) public { answer = answer_; updatedAt = updatedAt_; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract TestRouter {
    uint256 public outputBps = 10000;
    function setOutputBps(uint256 bps) external { outputBps = bps; }
    function getAmountsOut(uint256 amountIn, address[] calldata path) public view returns (uint256[] memory amounts) {
        amounts = new uint256[](2); amounts[0] = amountIn;
        // Both fixtures have price $1; decimals intentionally differ.
        amounts[1] = amountIn * (10 ** ERC20(path[1]).decimals()) / (10 ** ERC20(path[0]).decimals()) * outputBps / 10000;
    }
    function swapExactTokensForTokens(uint256 amountIn, uint256 minOut, address[] calldata path, address to, uint256 deadline)
        external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "expired");
        amounts = getAmountsOut(amountIn, path);
        require(amounts[1] >= minOut, "slippage");
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn));
        require(IERC20(path[1]).transfer(to, amounts[1]));
    }
}
