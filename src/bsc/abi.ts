import { parseAbi } from "viem";

export const vaultAbi = parseAbi([
  "function owner() view returns (address)", "function operator() view returns (address)",
  "function token0() view returns (address)", "function token1() view returns (address)",
  "function router() view returns (address)", "function paused() view returns (bool)",
  "function prices() view returns (uint256,uint256)", "function executionNonce() view returns (uint256)",
  "function spentTodayUsd() view returns (uint256)", "function spendDay() view returns (uint256)",
  "function lastExecutionAt() view returns (uint256)",
  "function policy() view returns (uint256 maxActionUsd,uint256 maxDailyUsd,uint16 targetToken0Bps,uint16 maxSlippageBps,uint32 cooldownSeconds,uint32 maxOracleAge)",
  "function rebalance(bool sellToken0,uint256 amountIn,uint256 minAmountOut,uint256 deadline,uint256 expectedNonce,bytes32 planId)",
  "function setPaused(bool next)", "function deposit(bool isToken0,uint256 amount)",
  "function withdraw(bool isToken0,uint256 amount)",
  "event Rebalanced(bytes32 indexed planId,uint256 indexed nonce,address indexed tokenIn,uint256 amountIn,uint256 amountOut,uint256 notionalUsd,uint256 driftBeforeBps,uint256 driftAfterBps)"
]);
export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)",
  "function symbol() view returns (string)", "function approve(address,uint256) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)"
]);
export const routerAbi = parseAbi(["function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[])"]);
