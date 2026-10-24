import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import solc from "solc";
import type { Abi, Hex } from "viem";

export type Artifact = { abi: Abi; bytecode: Hex };
let cached: Record<string, Artifact> | undefined;
export function compileContracts(): Record<string, Artifact> {
  if (cached) return cached;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sources = Object.fromEntries(["contracts/AgentGuardVault.sol", "contracts/test/Fixtures.sol"].map(path =>
    [path, { content: readFileSync(resolve(root, path), "utf8") }]));
  const result = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  } }), { import: (path: string) => {
    if (!path.startsWith("@openzeppelin/contracts/") || path.includes("..")) return { error: "Import not allowed" };
    try { return { contents: readFileSync(resolve(root, "node_modules", path), "utf8") }; }
    catch { return { error: `Missing ${path}` }; }
  } }));
  const errors = (result.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const artifacts: Record<string, Artifact> = {};
  for (const contracts of Object.values(result.contracts) as Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>[]) {
    for (const [name, artifact] of Object.entries(contracts)) if (artifact.evm.bytecode.object)
      artifacts[name] = { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
  }
  cached = artifacts;
  return artifacts;
}
