import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, http, keccak256,
  parseAbi, parseEther, type Abi, type Address, type Hash, type Hex } from "viem";
import { compileContracts } from "./compiler.js";
import { localChain } from "./local.js";
import { tokenAbi, vaultAbi } from "./abi.js";
import { json, planFromChain, verifyExecution } from "./rebalancer.js";
import { startReadOnlyRpc } from "./read-only-rpc.js";
import { saveDependencyReport as saveForkReport } from "./dependency-report.js";

export const forkDependencies = {
  router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  token0: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
  token1: "0x55d398326f99059fF775485246999027B3197955", // Binance-Peg USDT
  feed0: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
  feed1: "0xB97Ad0E74fa7d920791E90258A6E2085088b4320"
} as const;
const integrationAbi = parseAbi([
  "function factory() view returns (address)", "function WETH() view returns (address)",
  "function getPair(address,address) view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function description() view returns (string)", "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function deposit() payable",
  "function allowance(address,address) view returns (uint256)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])"
]);

export async function runMainnetFork(endpoint: string, selectedBlock?: bigint) {
  const relay = await startReadOnlyRpc(endpoint);
  let closeNode = async () => {};
  let stage = "source anchor";
  const stop = () => { void closeNode(); void relay.close(); };
  const deadline = setTimeout(stop, 180000);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const source = createPublicClient({ transport: http(relay.url, { retryCount: 0, timeout: 20000 }), cacheTime: 0 });
    assert.equal(await source.getChainId(), 56, "Fork source must be BSC mainnet");
    const head = await source.getBlockNumber();
    const blockNumber = selectedBlock ?? head - 64n;
    assert.ok(blockNumber > 0n && blockNumber <= head - 2n, "Use a mined source block with confirmation depth");
    const anchor = await source.getBlock({ blockNumber });
    assert.ok(anchor.hash, "Source block hash required");
    const addresses = Object.entries(forkDependencies);
    const sourceCodes: { name: string; address: Address; codeHash: Hash }[] = await Promise.all(addresses.map(async ([name, address]) => {
      const code = await source.getCode({ address, blockNumber });
      assert.ok(code && code !== "0x", `${name} missing at source block`);
      return { name, address, codeHash: keccak256(code) };
    }));
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer(); probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as { port: number }).port;
        probe.close(error => error ? reject(error) : resolve(port)); });
    });
    stage = "fork startup";
    const node = spawn(process.execPath, [
      fileURLToPath(new URL("../../node_modules/@foundry-rs/anvil/bin.mjs", import.meta.url)),
      "--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337",
      "--hardfork", "shanghai", "--fork-url", relay.url, "--fork-block-number", String(blockNumber),
      "--no-storage-caching", "--retries", "0", "--timeout", "15000", "--accounts", "3", "--quiet"
    ], { stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
    let nodeError = "";
    node.stderr.on("data", chunk => { nodeError = (nodeError + chunk).slice(-2000); });
    let spawnError: unknown;
    node.on("error", error => { spawnError = error; });
    closeNode = async () => {
      if (node.exitCode !== null || spawnError) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => node.kill("SIGKILL"), 2000);
        node.once("exit", () => { clearTimeout(timer); resolve(); }); node.kill("SIGTERM");
      });
    };
    const url = `http://127.0.0.1:${port}`;
    const client = createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20000 }), cacheTime: 0, pollingInterval: 50 });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError || node.exitCode !== null) throw new Error(`Fork node could not start: ${nodeError} ${relay.lastFailure()} ${json(relay.counts)}`);
      try { if (await client.getChainId() === 31337) { ready = true; break; } } catch { /* Startup only. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Fork startup timed out");
    assert.equal((await client.getBlock({ blockNumber })).hash, anchor.hash, "Fork must match source anchor");
    const wallet = createWalletClient({ transport: http(url), chain: localChain });
    const [owner, operator] = await wallet.getAddresses();
    const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never);
    const wait = (hash: Hash) => client.waitForTransactionReceipt({ hash, timeout: 20000 });
    const send = async (account: Address, request: { to?: Address; data: Hex; value?: bigint }) => {
      assert.equal(await wallet.getChainId(), 31337, "Writes are confined to the isolated fork");
      const estimate = await client.estimateGas({ account, ...request });
      const hash = await wallet.sendTransaction({ account, ...request, gas: (estimate * 120n + 99n) / 100n });
      assert.equal((await wait(hash)).status, "success", "Fork transaction reverted");
      return hash;
    };
    const write = (account: Address, address: Address, functionName: string, args: readonly unknown[] = [], value = 0n) =>
      send(account, { to: address, data: encodeFunctionData({ abi: integrationAbi as Abi, functionName, args }), value });
    stage = "protocol and oracle checks";
    const d = forkDependencies;
    for (const entry of sourceCodes) {
      const code = await client.getCode({ address: entry.address });
      assert.equal(keccak256(code!), entry.codeHash, `Fork substituted ${entry.name} code`);
    }
    assert.equal((await client.readContract({ address: d.router, abi: integrationAbi, functionName: "factory" })).toLowerCase(), d.factory.toLowerCase());
    assert.equal((await client.readContract({ address: d.router, abi: integrationAbi, functionName: "WETH" })).toLowerCase(), d.token0.toLowerCase());
    const pair = await client.readContract({ address: d.factory, abi: integrationAbi, functionName: "getPair", args: [d.token0, d.token1] });
    const pairSourceCode = await source.getCode({ address: pair, blockNumber });
    assert.ok(pairSourceCode && pairSourceCode !== "0x", "Source pair code required");
    const pairCodeHash = keccak256(pairSourceCode);
    assert.equal(keccak256((await client.getCode({ address: pair }))!), pairCodeHash, "Fork substituted pair code");
    sourceCodes.push({ name: "pair", address: pair, codeHash: pairCodeHash });
    const reservesBefore = await client.readContract({ address: pair, abi: integrationAbi, functionName: "getReserves" });
    assert.deepEqual(reservesBefore, await source.readContract({ address: pair, abi: integrationAbi, functionName: "getReserves", blockNumber }));
    assert.ok(reservesBefore[0] > 0n && reservesBefore[1] > 0n, "Real direct-route liquidity required");
    const feeds = await Promise.all(([d.feed0, d.feed1] as const).map(async address => {
      const description = await client.readContract({ address, abi: integrationAbi, functionName: "description" });
      const decimals = await client.readContract({ address, abi: integrationAbi, functionName: "decimals" });
      const round = await client.readContract({ address, abi: integrationAbi, functionName: "latestRoundData" });
      assert.ok(round[1] > 0n && round[3] > 0n && round[3] <= anchor.timestamp && anchor.timestamp - round[3] <= 3600n &&
        round[4] >= round[0], "Fresh positive source oracle round required");
      return { address, description, decimals, round };
    }));
    assert.equal(feeds[0].description, "BNB / USD"); assert.equal(feeds[1].description, "USDT / USD");
    assert.equal(await client.readContract({ address: d.token0, abi: tokenAbi, functionName: "decimals" }), 18);
    assert.equal(await client.readContract({ address: d.token1, abi: tokenAbi, functionName: "decimals" }), 18);
    const policy = { maxActionUsd: parseEther("10"), maxDailyUsd: parseEther("25"), targetToken0Bps: 5000,
      maxSlippageBps: 100, cooldownSeconds: 300, maxOracleAge: 3600 };
    stage = "local vault deployment";
    const deploymentHash = await send(owner, { data: encodeDeployData({ ...compileContracts().AgentGuardVault,
      args: [owner, operator, d.token0, d.token1, d.router, d.feed0, d.feed1, policy] }) });
    const vault = (await wait(deploymentHash)).contractAddress!;
    // Synthetic Anvil native balance only; acquire tokens by wrapping and using the real router.
    // No token mint/storage replacement, whale impersonation, or oracle overrides.
    stage = "local protocol funding";
    await write(owner, d.token0, "deposit", [], parseEther("0.1"));
    const seedAmount = parseEther("0.02"), path = [d.token0, d.token1];
    const approve = (token: Address, spender: Address, amount: bigint) =>
      send(owner, { to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [spender, amount] }) });
    await approve(d.token0, d.router, seedAmount);
    const seedQuote = await client.readContract({ address: d.router, abi: integrationAbi, functionName: "getAmountsOut", args: [seedAmount, path] });
    await write(owner, d.router, "swapExactTokensForTokens",
      [seedAmount, seedQuote[1] * 99n / 100n, path, owner, (await client.getBlock()).timestamp + 120n]);
    for (const [token, side] of [[d.token0, true], [d.token1, false]] as const) {
      const amount = await client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [owner] });
      await approve(token, vault, amount);
      await send(owner, { to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [side, amount] }) });
    }
    stage = "bounded rebalance and receipt";
    const { snapshot, decision } = await planFromChain(client, vault);
    assert.equal(decision.state, "READY", json(decision));
    if (decision.state !== "READY") throw new Error("Fork did not produce a plan");
    const hash = await send(operator, { to: vault, data: decision.plan.data });
    await rpc("evm_mine");
    const verified = await verifyExecution(client, decision.plan, hash);
    assert.equal(verified.state, "VERIFIED", json(verified));
    const after = await planFromChain(client, vault);
    assert.equal(after.decision.state, "BLOCKED");
    if (after.decision.state === "BLOCKED") assert.ok(after.decision.reasons.includes("cooldown_active"));
    await send(owner, { to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "setPaused", args: [true] }) });
    const paused = await planFromChain(client, vault);
    assert.equal(paused.decision.state, "BLOCKED");
    if (paused.decision.state === "BLOCKED") assert.ok(paused.decision.reasons.includes("vault_paused"));
    const allowance = await client.readContract({ address: decision.plan.tokenIn, abi: integrationAbi, functionName: "allowance", args: [vault, d.router] });
    assert.equal(allowance, 0n, "Router authority must be cleared after execution");
    const reservesAfter = await client.readContract({ address: pair, abi: integrationAbi, functionName: "getReserves" });
    assert.notDeepEqual(reservesAfter.slice(0, 2), reservesBefore.slice(0, 2), "Real pair reserves must change locally");
    assert.equal((await source.getBlock({ blockNumber })).hash, anchor.hash, "Source anchor changed during verification");
    assert.equal(relay.counts.deniedRequests, 0, `Unexpected upstream methods denied: ${[...relay.deniedMethods].join(",")}`);
    const report = {
      status: "FORK_SIMULATION_VERIFIED", environment: "BSC_MAINNET_FORK", chainId: 31337, sourceChainId: 56,
      sourceBlock: blockNumber, sourceBlockHash: anchor.hash, sourceTimestamp: anchor.timestamp,
      sourceCode: sourceCodes, dependencies: d, feeds, pair, reservesBefore, reservesAfter,
      localVault: vault, localDeploymentHash: deploymentHash, snapshot, plan: decision.plan,
      verified, cooldown: after.decision, pause: paused.decision, remainingRouterAllowance: allowance,
      remoteAccess: { policy: "READ_ONLY_ALLOWLIST", ...relay.counts },
      campaignProof: false, marketEvidence: false, mainnetTransactionCreated: false,
      checkedAt: new Date().toISOString(),
      note: "Local fork execution with copied PancakeSwap liquidity and Chainlink feeds. Synthetic native funding. Hashes are local, not BscScan transactions. No public-chain write or independent public execution proof."
    };
    return { ...report, reportHash: createHash("sha256").update(json(report)).digest("hex") };
  } catch (error) {
    const detail = error instanceof assert.AssertionError ? error.message.slice(0, 1500) : error instanceof Error ? error.name : "Unknown error";
    throw new Error(`Fork verification failed at ${stage}; upstream=${relay.lastFailure() || "no transport failure"}; reads=${relay.counts.forwardedReads}; retries=${relay.counts.retries}; check=${detail}. No mainnet write permitted.`);
  } finally {
    clearTimeout(deadline); process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await closeNode(); await relay.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const value = process.env.BSC_FORK_BLOCK;
    if (value && !/^[1-9]\d*$/.test(value)) throw new Error("Invalid fork block");
    const result = await runMainnetFork(process.env.BSC_MAINNET_FORK_RPC_URL || "https://bsc-dataseed.bnbchain.org", value ? BigInt(value) : undefined);
    await saveForkReport(".runtime/bsc-mainnet-fork.json", result);
    console.log(json(result));
  } catch (error) {
    await saveForkReport(".runtime/bsc-mainnet-fork.json", {
      status: "FORK_VERIFICATION_FAILED", environment: "BSC_MAINNET_FORK",
      campaignProof: false, marketEvidence: false, mainnetTransactionCreated: false,
      checkedAt: new Date().toISOString()
    }).catch(() => { console.error("Could not save failed fork report."); });
    if (error instanceof Error && error.message.startsWith("Fork verification failed at ")) console.error(error.message);
    console.error("Fork verification failed. Check source archive availability, fresh Chainlink rounds and direct-route liquidity. No mainnet transaction was permitted.");
    process.exitCode = 1;
  }
}
