import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Hash } from "viem";
import { parseDeploymentConfig, testnetClients, verifyDeployment } from "./deployment.js";
import { json } from "./rebalancer.js";

try {
  const [configPath, hash] = process.argv.slice(2);
  if (!configPath || !hash) throw new Error("Config path and transaction hash required");
  const config = parseDeploymentConfig(JSON.parse(await readFile(configPath, "utf8")));
  const { verifier } = await testnetClients(process.env.BSC_TESTNET_RPC_URL, process.env.BSC_VERIFIER_RPC_URL);
  const proof = await verifyDeployment(verifier, config, hash as Hash);
  await mkdir(".runtime", { recursive: true });
  const output = `.runtime/bsc-deployment-${hash.toLowerCase()}.json`;
  await writeFile(output, json(proof) + "\n", { mode: 0o600 });
  console.log(json({ ...proof, output }));
  if (proof.state !== "VERIFIED") process.exitCode = proof.state === "PENDING" ? 2 : 1;
} catch { console.error("Deployment verification unavailable. Check configuration, hash and independent archive RPC. No successful attestation was written."); process.exitCode = 1; }
