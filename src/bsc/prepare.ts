import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { json } from "./rebalancer.js";
import { identityRegistry, registrationCard, registrationTransaction } from "./identity.js";
import { parseDeploymentConfig, prepareDeployment } from "./deployment.js";

async function main() {
  const configPath = process.argv[2];
  if (!configPath || !process.env.BSC_TESTNET_RPC_URL) throw new Error("Usage: npm run bsc:prepare -- config/bsc-testnet.json (set BSC_TESTNET_RPC_URL in .env)");
  const config = parseDeploymentConfig(JSON.parse(await readFile(configPath, "utf8")));
  const rpcUrl = process.env.BSC_TESTNET_RPC_URL;
  if (new URL(rpcUrl).protocol !== "https:") throw new Error("Use an HTTPS RPC URL");
  const client = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  const output = await prepareDeployment(client, config);
  const owner = config.owner;
  if (config.publicBaseUrl) {
    const code = await client.getCode({ address: identityRegistry });
    if (!code || code === "0x") throw new Error("ERC-8004 registry code not found");
  }
  await mkdir(".runtime", { recursive: true });
  await writeFile(".runtime/bsc-deployment-transaction.json", json(output) + "\n", { mode: 0o600 });
  if (config.publicBaseUrl) {
    await writeFile(".runtime/agent-registration.json", json(registrationCard(config.publicBaseUrl)) + "\n");
    await writeFile(".runtime/bsc-registration-transaction.json", json({ status: "UNSIGNED_UNREGISTERED", transaction: registrationTransaction(config.publicBaseUrl, owner) }) + "\n");
  }
  console.log(json({ status: output.status, output: ".runtime/bsc-deployment-transaction.json", owner, chainId: 97,
    financialTransactionCreated: false, privateKeyRequired: false }));
}
main().catch(() => { console.error("Deployment preparation failed. Check local config, HTTPS chain-97 RPC and dependency contracts. No transaction was sent."); process.exitCode = 1; });
