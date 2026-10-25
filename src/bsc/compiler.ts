import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import solc from "solc";
import { toHex, type Abi, type Hex } from "viem";

type ImmutableRange = { start: number; length: number };
export type Artifact = { abi: Abi; bytecode: Hex; deployedBytecode: Hex; immutableReferences: Record<string, ImmutableRange[]> };

// Bind every compiler immutable slot to its expected constructor value. Do not
// mask these ranges: child addresses are part of the runtime being attested.
export function expectedRuntimeCode(artifact: Artifact, values: Record<string, bigint | string | number>): Hex {
  let code = artifact.deployedBytecode.slice(2);
  for (const [name, ranges] of Object.entries(artifact.immutableReferences)) {
    if (!Object.hasOwn(values, name)) throw new Error(`Missing expected immutable: ${name}`);
    const value = toHex(BigInt(values[name]), { size: 32 }).slice(2);
    for (const { start, length } of ranges) {
      if (length !== 32 || start < 0 || (start + length) * 2 > code.length) throw new Error("Invalid compiler immutable range");
      code = code.slice(0, start * 2) + value + code.slice((start + length) * 2);
    }
  }
  return `0x${code}`;
}
let cached: Record<string, Artifact> | undefined;
export function compileContracts(): Record<string, Artifact> {
  if (cached) return cached;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sources = Object.fromEntries(["contracts/AgentGuardVault.sol", "contracts/test/Fixtures.sol", "contracts/test/ControlledEnvironment.sol"].map(path =>
    [path, { content: readFileSync(resolve(root, path), "utf8") }]));
  const result = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "shanghai",
    outputSelection: { "*": { "": ["ast"], "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } }
  } }), { import: (path: string) => {
    if (!path.startsWith("@openzeppelin/contracts/") || path.includes("..")) return { error: "Import not allowed" };
    try { return { contents: readFileSync(resolve(root, "node_modules", path), "utf8") }; }
    catch { return { error: `Missing ${path}` }; }
  } }));
  const errors = (result.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const immutableNames = new Map<string, string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (item.nodeType === "VariableDeclaration" && item.mutability === "immutable") immutableNames.set(String(item.id), String(item.name));
    for (const value of Object.values(item)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value);
  };
  for (const source of Object.values(result.sources)) visit(source);
  const artifacts: Record<string, Artifact> = {};
  for (const contracts of Object.values(result.contracts) as Record<string, { abi: Abi; evm: {
    bytecode: { object: string }; deployedBytecode: { object: string; immutableReferences: Record<string, ImmutableRange[]> }
  } }>[]) {
    for (const [name, artifact] of Object.entries(contracts)) if (artifact.evm.bytecode.object) {
      const references: Record<string, ImmutableRange[]> = {};
      for (const [id, ranges] of Object.entries(artifact.evm.deployedBytecode.immutableReferences)) {
        const variable = immutableNames.get(id);
        if (!variable || references[variable]) throw new Error("Unresolved or ambiguous compiler immutable");
        references[variable] = ranges;
      }
      artifacts[name] = { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`,
        deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`, immutableReferences: references };
    }
  }
  cached = artifacts;
  return artifacts;
}
