import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hash } from "viem";
import { compileContracts } from "../../src/bsc/compiler.js";
import { controlledDeploymentData } from "../../src/bsc/controlled.js";

// Isolated Anvil with chain id 97, NOT a public BSC client or campaign proof.
// Unrestricted local-fixture contracts remain confined to the 31337 fixture.
export async function controlledFixture() {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer(); probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as { port: number }).port;
      probe.close(error => error ? reject(error) : resolve(port)); });
  });
  const url = `http://127.0.0.1:${port}`;
  const processHandle = spawn(process.execPath, [fileURLToPath(new URL("../../node_modules/@foundry-rs/anvil/bin.mjs", import.meta.url)),
    "--host", "127.0.0.1", "--port", String(port), "--chain-id", "97", "--hardfork", "shanghai", "--accounts", "3", "--quiet"], { stdio: "ignore" });
  let spawnError: unknown;
  processHandle.on("error", error => { spawnError = error; });
  const close = async () => {
    if (spawnError || processHandle.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => processHandle.kill("SIGKILL"), 2000);
      processHandle.once("exit", () => { clearTimeout(timeout); resolve(); }); processHandle.kill("SIGTERM");
    });
  };
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }), cacheTime: 0, pollingInterval: 20 });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError || processHandle.exitCode !== null) throw new Error("Isolated test node failed", { cause: spawnError });
      try { if (await client.getChainId() === 97) { ready = true; break; } } catch { /* Startup only. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("Isolated test node timeout");
    const wallet = createWalletClient({ transport: http(url), chain: defineChain({ id: 97, name: "Isolated controlled test",
      nativeCurrency: { name: "Test", symbol: "TEST", decimals: 18 }, rpcUrls: { default: { http: [url] } } }) });
    const [owner, operator, stranger] = await wallet.getAddresses();
    const rpc = (method: string, params: unknown[] = []) => client.request({ method, params } as never);
    const wait = (hash: Hash) => client.waitForTransactionReceipt({ hash });
    const deploy = async () => {
      const hash = await wallet.sendTransaction({ account: owner, data: controlledDeploymentData(owner), value: 0n });
      const receipt = await wait(hash);
      if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Test environment deployment reverted");
      return { hash, receipt, address: receipt.contractAddress };
    };
    const write = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], account = owner) => {
      // A write mined at a new timestamp can cost more than the latest-block estimate.
      const estimate = await client.estimateContractGas({ address, abi, functionName, args, account });
      const hash = await wallet.writeContract({ address, abi, functionName, args, account, gas: (estimate * 120n + 99n) / 100n });
      if ((await wait(hash)).status !== "success") throw new Error("Test transaction reverted");
      return hash;
    };
    return { client, wallet, owner, operator, stranger, rpc, wait, deploy, write, artifacts: compileContracts(), close };
  } catch (error) { await close(); throw error; }
}
export type ControlledFixture = Awaited<ReturnType<typeof controlledFixture>>;
