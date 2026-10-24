import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { encodeFunctionData } from "viem";
import { startLocalFixture, sendLocalTransaction, type LocalFixture } from "./local.js";
import { planFromChain, verifyExecution, json, type Plan } from "./rebalancer.js";
import { vaultAbi } from "./abi.js";

export async function executeLocal(f: LocalFixture, plan: Plan) {
  const hash = await sendLocalTransaction(f, { account: f.operator, to: plan.vault, data: plan.data, value: 0n });
  await f.wait(hash);
  await f.rpc("evm_mine");
  return verifyExecution(f.client, plan, hash, 2);
}

export async function runLocalDemo() {
  const f = await startLocalFixture();
  try {
    const first = await planFromChain(f.client, f.vault);
    if (first.decision.state !== "READY") throw new Error("Fixture did not produce a plan");
    const verified = await executeLocal(f, first.decision.plan);
    if (verified.state !== "VERIFIED") throw new Error(json(verified));
    await f.write(f.vault, vaultAbi, "setPaused", [true]);
    const blocked = await planFromChain(f.client, f.vault);
    const wrongHash = await f.wallet.sendTransaction({ account: f.owner, to: f.vault,
      data: encodeFunctionData({ abi: vaultAbi, functionName: "setPaused", args: [false] }) });
    await f.wait(wrongHash); await f.rpc("evm_mine");
    const frozen = await verifyExecution(f.client, first.decision.plan, wrongHash);
    return { environment: "LOCAL_EVM", chainId: 31337, campaignProof: false,
      description: "Real local EVM bytecode execution with mock tokens, oracle feeds and router. Not public BSC activity.",
      verified, blocked: blocked.decision, frozen };
  } finally { await f.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runLocalDemo();
  await mkdir(".runtime", { recursive: true });
  await writeFile(".runtime/bsc-local-demo.json", json(result) + "\n");
  console.log(json(result));
}
