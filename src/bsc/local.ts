import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, type Abi, type Address, type Hash, type Hex } from "viem";
import { compileContracts } from "./compiler.js";
import { vaultAbi, tokenAbi } from "./abi.js";

export const localChain = defineChain({ id: 31337, name: "AgentGuard isolated local EVM",
  nativeCurrency: { name: "Local test ether", symbol: "TEST", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } } });

export async function startLocalFixture(excludedPorts: readonly number[] = []) {
  // The OS ephemeral range can include the HTTP console port. Do not let
  // Anvil bind it while the console is still preparing its contracts.
  let port: number;
  do { port = await new Promise<number>((resolve, reject) => {
    const probe = createServer(); probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as { port: number }).port;
      probe.close(error => error ? reject(error) : resolve(port)); });
  }); } while (excludedPorts.includes(port));
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [fileURLToPath(new URL("../../node_modules/@foundry-rs/anvil/bin.mjs", import.meta.url)),
    "--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--hardfork", "shanghai", "--accounts", "4", "--quiet"],
    { stdio: "ignore" });
  let spawnError: Error | undefined;
  server.on("error", error => { spawnError = error; });
  const close = async () => {
    if (server.exitCode !== null || spawnError) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { server.kill("SIGKILL"); }, 2000);
      server.once("exit", () => { clearTimeout(timeout); resolve(); }); server.kill("SIGTERM");
    });
  };
  try {
    let running = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError || server.exitCode !== null) throw new Error("Local Anvil could not start", { cause: spawnError });
      try { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
        if ((await response.json() as { result?: string }).result === "0x7a69") { running = true; break; }
      } catch { /* Wait briefly for the isolated process to bind its loopback port. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!running) throw new Error("Local Anvil startup timed out");
    const client = createPublicClient({ transport: http(url), cacheTime: 0, pollingInterval: 20 });
    const wallet = createWalletClient({ transport: http(url), chain: localChain });
    const [owner, operator, stranger] = await wallet.getAddresses();
    const artifacts = compileContracts();
    const wait = (hash: Hash) => client.waitForTransactionReceipt({ hash });
    const deploy = async (name: string, args: readonly unknown[] = []) => {
      const artifact = artifacts[name];
      const hash = await wallet.deployContract({ ...artifact, args, account: owner });
      const receipt = await wait(hash);
      if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`Local deployment failed: ${name}`);
      return receipt.contractAddress;
    };
    const write = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], account = owner) => {
      const hash = await wallet.writeContract({ address, abi, functionName, args, account });
      const receipt = await wait(hash);
      if (receipt.status !== "success") throw new Error(`Transaction reverted: ${functionName}`);
      return hash;
    };
    const token0 = await deploy("TestToken", ["TEST-A", 18]);
    const token1 = await deploy("TestToken", ["TEST-B", 6]);
    const feed0 = await deploy("TestFeed", [100000000n]); const feed1 = await deploy("TestFeed", [100000000n]);
    const router = await deploy("TestRouter");
    const policy = { maxActionUsd: parseUnits("10", 18), maxDailyUsd: parseUnits("25", 18),
      targetToken0Bps: 5000, maxSlippageBps: 100, cooldownSeconds: 0, maxOracleAge: 3600 };
    const vault = await deploy("AgentGuardVault", [owner, operator, token0, token1, router, feed0, feed1, policy]);
    await write(token0, artifacts.TestToken.abi, "mint", [owner, parseUnits("80", 18)]);
    await write(token1, artifacts.TestToken.abi, "mint", [owner, parseUnits("20", 6)]);
    await write(token0, artifacts.TestToken.abi, "mint", [router, parseUnits("10000", 18)]);
    await write(token1, artifacts.TestToken.abi, "mint", [router, parseUnits("10000", 6)]);
    await write(token0, tokenAbi, "approve", [vault, parseUnits("80", 18)]);
    await write(token1, tokenAbi, "approve", [vault, parseUnits("20", 6)]);
    await write(vault, vaultAbi, "deposit", [true, parseUnits("80", 18)]);
    await write(vault, vaultAbi, "deposit", [false, parseUnits("20", 6)]);
    const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never);
    return { server, client, wallet, owner, operator, stranger, token0, token1, feed0, feed1, router, vault, policy, artifacts,
      write, wait, rpc, close };
  } catch (error) { await close(); throw error; }
}
export type LocalFixture = Awaited<ReturnType<typeof startLocalFixture>>;

export async function sendLocalTransaction(f: LocalFixture, request: { account: Address; to: Address; data: Hex; value: bigint }) {
  // Anvil's exact estimate can become insufficient when the mined timestamp
  // changes a storage write (for example lastExecutionAt) after estimation.
  const estimate = await f.client.estimateGas(request);
  return f.wallet.sendTransaction({ ...request, gas: estimate + (estimate + 4n) / 5n });
}
