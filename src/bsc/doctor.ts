import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";
import { isAddress, zeroAddress } from "viem";
import { parseDeploymentConfig, testnetClients } from "./deployment.js";
import { deploymentPreflight } from "./preflight.js";
import { json } from "./rebalancer.js";

export function inspectLocalConfiguration(raw: unknown, env: Record<string, string | undefined>) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const issues: { field: string; action: string }[] = [];
  for (const field of ["owner", "operator", "token0", "token1", "router", "feed0", "feed1"]) {
    const value = input[field];
    if (typeof value !== "string" || !isAddress(value) || value.toLowerCase() === zeroAddress) issues.push({ field, action: "Set a nonzero public address for this campaign on BSC testnet. Never enter a private key." });
  }
  try { parseDeploymentConfig(raw); }
  catch { if (!issues.length) issues.push({ field: "policy_or_public_origin", action: "Check USD decimal strings, policy bounds, distinct assets and optional HTTPS origin in config/bsc-testnet.json." }); }
  for (const field of ["BSC_TESTNET_RPC_URL", "BSC_VERIFIER_RPC_URL"]) {
    try { if (new URL(env[field] ?? "").protocol !== "https:") throw new Error(); }
    catch { issues.push({ field, action: "Set an HTTPS chain-97 RPC endpoint in the ignored .env file. Its value will not be printed." }); }
  }
  if (!issues.some(i => i.field.includes("RPC_URL")) && new URL(env.BSC_TESTNET_RPC_URL!).hostname === new URL(env.BSC_VERIFIER_RPC_URL!).hostname)
    issues.push({ field: "independent_rpc", action: "Use different RPC provider hostnames for planning and verification." });
  return { state: issues.length ? "BLOCKED" as const : "CONFIGURED_NOT_CHAIN_VERIFIED" as const,
    issues, checkedAt: new Date().toISOString(), campaignProof: false, financialTransactionCreated: false,
    note: "Offline configuration check. No wallet request, network call, registration or transaction is made." };
}

async function main() {
  try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const args = process.argv.slice(2), configPath = args.find(arg => !arg.startsWith("--")) ?? "config/bsc-testnet.json";
  let raw: unknown;
  try { raw = JSON.parse(await readFile(configPath, "utf8")); } catch { raw = undefined; }
  const local = inspectLocalConfiguration(raw, process.env);
  let report: unknown = local;
  if (local.state !== "BLOCKED" && args.includes("--online")) {
    const { client, verifier } = await testnetClients(process.env.BSC_TESTNET_RPC_URL, process.env.BSC_VERIFIER_RPC_URL);
    report = await deploymentPreflight(client, verifier, parseDeploymentConfig(raw));
  }
  await mkdir(".runtime", { recursive: true });
  await writeFile(".runtime/bsc-doctor.json", json(report) + "\n", { mode: 0o600 });
  console.log(json(report));
  if ((report as { state: string }).state === "BLOCKED") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error("Configuration check unavailable. Check local JSON/.env and independent chain-97 RPCs. No secrets were printed and no transaction was sent."); process.exitCode = 1;
});
