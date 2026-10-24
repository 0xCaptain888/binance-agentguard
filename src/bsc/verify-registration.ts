import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Hash } from "viem";
import { parseDeploymentConfig, testnetClients } from "./deployment.js";
import { json } from "./rebalancer.js";
import { verifiedRegistration, verifyRegistration } from "./identity.js";

try {
  const [configPath, hash] = process.argv.slice(2);
  if (!configPath || !hash) throw new Error("Config path and transaction hash required");
  const config = parseDeploymentConfig(JSON.parse(await readFile(configPath, "utf8")));
  if (!config.publicBaseUrl) throw new Error("Public base URL required");
  const { client, verifier } = await testnetClients(process.env.BSC_TESTNET_RPC_URL, process.env.BSC_VERIFIER_RPC_URL);
  const proof = await verifyRegistration(client, verifier, config.publicBaseUrl, config.owner, hash as Hash);
  await mkdir(".runtime", { recursive: true });
  const output = `.runtime/bsc-registration-${hash.toLowerCase()}.json`;
  await writeFile(output, json(proof) + "\n", { mode: 0o600 });
  console.log(json({ ...proof, registration: verifiedRegistration(proof), output }));
  if (proof.state !== "VERIFIED") process.exitCode = proof.state === "PENDING" ? 2 : 1;
} catch {
  console.error("Registration verification unavailable. Check the public HTTPS origin, owner, hash and both chain-97 RPCs. No successful attestation was written.");
  process.exitCode = 1;
}
