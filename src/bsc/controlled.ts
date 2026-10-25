import { createHash } from "node:crypto";
import { encodeDeployData, encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256, parseAbi, parseUnits,
  TransactionReceiptNotFoundError, zeroAddress, type Address, type Hash, type PublicClient } from "viem";
import { compileContracts, expectedRuntimeCode, type Artifact } from "./compiler.js";
import { parseDeploymentConfig } from "./deployment.js";
import { tokenAbi } from "./abi.js";
import { json } from "./rebalancer.js";
import { controlledDisclosure } from "./dependency-disclosure.js";
export { controlledDisclosure, dependencyDisclosure } from "./dependency-disclosure.js";

export const controlledAbi = parseAbi([
  "function owner() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)",
  "function feed0() view returns (address)", "function feed1() view returns (address)", "function router() view returns (address)"
]);
const feedAbi = parseAbi(["function owner() view returns (address)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const routerAbi = parseAbi(["function controlledTestEnvironment() view returns (bool)", "function token0() view returns (address)",
  "function token1() view returns (address)", "function environment() view returns (address)"]);
type Dependencies = { token0: Address; token1: Address; feed0: Address; feed1: Address; router: Address };
export function controlledOwner(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error("Nonzero owner public address required");
  return getAddress(value);
}
export function controlledDeploymentData(owner: Address) {
  return encodeDeployData({ ...compileContracts().ControlledEnvironment, args: [controlledOwner(owner)] });
}
const quantity = (value: bigint) => `0x${value.toString(16)}`;
export async function prepareControlledEnvironment(client: PublicClient, owner: Address, anchorBlock?: bigint) {
  owner = controlledOwner(owner);
  if (await client.getChainId() !== 97) throw new Error("BSC testnet 97 only");
  const block = await client.getBlock(anchorBlock === undefined ? {} : { blockNumber: anchorBlock });
  if (block.number === null || !block.hash) throw new Error("Mined block required");
  if (anchorBlock !== undefined && block.number !== anchorBlock) throw new Error("Requested anchor block mismatch");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (block.timestamp > now + 30n || block.timestamp < now - 120n) throw new Error("Recent chain state required");
  const [code, balance, gas, gasPrice] = await Promise.all([
    client.getCode({ address: owner, blockNumber: block.number }), client.getBalance({ address: owner, blockNumber: block.number }),
    client.estimateGas({ account: owner, data: controlledDeploymentData(owner), value: 0n, blockNumber: block.number }), client.getGasPrice()
  ]);
  if (code && code !== "0x") throw new Error("EOA owner required");
  const gasLimit = (gas * 120n + 99n) / 100n, bufferedCost = gasLimit * gasPrice;
  if (gas <= 0n || gasPrice <= 0n || balance < bufferedCost) throw new Error("Insufficient native test gas for estimate plus 20% buffer");
  if (gasLimit > block.gasLimit) throw new Error("Buffered deployment gas exceeds the block gas limit");
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("Canonical anchor changed");
  return { status: "UNSIGNED_CONTROLLED_TESTNET_DEPLOYMENT", ...controlledDisclosure, chainId: 97,
    owner, blockNumber: block.number, blockHash: block.hash, checkedAt: new Date().toISOString(),
    gas: { estimate: gas, limit: gasLimit, gasPrice, bufferedCost, ownerBalance: balance },
    initCodeHash: keccak256(controlledDeploymentData(owner)), initCodeBytes: (controlledDeploymentData(owner).length - 2) / 2,
    // Supply the complete legacy envelope. Some wallet bridges otherwise
    // construct a type-2 deployment with missing/zero fee fields.
    transaction: { from: owner, data: controlledDeploymentData(owner), value: "0x0", chainId: "0x61",
      type: "0x0", gas: quantity(gasLimit), gasPrice: quantity(gasPrice) },
    financialTransactionCreated: false };
}

export function reconcileControlledPreparations(primary: Awaited<ReturnType<typeof prepareControlledEnvironment>>,
  independent: Awaited<ReturnType<typeof prepareControlledEnvironment>>) {
  const sameAnchor = primary.chainId === independent.chainId && primary.owner.toLowerCase() === independent.owner.toLowerCase() &&
    primary.blockNumber === independent.blockNumber && primary.blockHash === independent.blockHash;
  // Gas prices are sampled outside the anchor and may legitimately differ.
  // Every other envelope field must match, including the actual gas limit.
  const sameDeployment = primary.initCodeHash === independent.initCodeHash &&
    primary.initCodeBytes === independent.initCodeBytes &&
    json({ ...primary.transaction, gasPrice: "" }) === json({ ...independent.transaction, gasPrice: "" });
  const sameFundingAndEstimate = primary.gas.ownerBalance === independent.gas.ownerBalance &&
    primary.gas.estimate === independent.gas.estimate && primary.gas.limit === independent.gas.limit;
  const consistentFees = [primary, independent].every(item => item.gas.gasPrice > 0n &&
    item.gas.limit === (item.gas.estimate * 120n + 99n) / 100n &&
    item.transaction.type === "0x0" && item.transaction.gas === quantity(item.gas.limit) &&
    item.transaction.gasPrice === quantity(item.gas.gasPrice) && item.gas.bufferedCost === item.gas.limit * item.gas.gasPrice);
  if (!sameAnchor || !sameDeployment || !sameFundingAndEstimate || !consistentFees)
    throw new Error("Independent preparation disagrees on anchor, deployment, balance or gas estimate");

  const gasPrice = primary.gas.gasPrice > independent.gas.gasPrice ? primary.gas.gasPrice : independent.gas.gasPrice;
  const bufferedCost = primary.gas.limit * gasPrice;
  if (primary.gas.ownerBalance < bufferedCost)
    throw new Error("Independent gas-price maximum exceeds the owner's 20% buffered test-gas balance");
  return {
    ...primary,
    gas: { ...primary.gas, gasPrice, bufferedCost },
    transaction: { ...primary.transaction, gasPrice: quantity(gasPrice) },
    independentChecked: true,
    independent: {
      blockNumber: independent.blockNumber, blockHash: independent.blockHash,
      ownerBalance: independent.gas.ownerBalance, gasEstimate: independent.gas.estimate,
      observedGasPrice: independent.gas.gasPrice
    }
  };
}

// A missing receipt cannot prove that a transaction was never broadcast.
// Recovery therefore keeps the saved nonce and exact deployment, never clears
// the lock to send a new nonce, and still requires a new owner wallet review.
export async function assertControlledRetryNonce(client: PublicClient, verifier: PublicClient, owner: Address, nonce: number) {
  owner = controlledOwner(owner);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Valid saved deployment nonce required");
  const reads = await Promise.all([client, verifier].map(async rpc => {
    if (await rpc.getChainId() !== 97) throw new Error("BSC testnet 97 only");
    return Promise.all([
      rpc.getTransactionCount({ address: owner, blockTag: "latest" }),
      rpc.getTransactionCount({ address: owner, blockTag: "pending" })
    ]);
  }));
  if (!reads.every(counts => counts.every(count => count === nonce)))
    throw new Error("Saved nonce is mined, pending, or disagrees across RPCs. Recover and verify the original transaction; no retry prepared.");
}

async function inspectControlled(client: PublicClient, owner: Address, hash: Hash, expectedNonce?: number) {
  if (await client.getChainId() !== 97) throw new Error("BSC testnet 97 only");
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash }); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return { state: "PENDING" as const }; throw error; }
  const head = await client.getBlockNumber({ cacheTime: 0 });
  if (head < receipt.blockNumber + 1n) return { state: "PENDING" as const };
  const [tx, block] = await Promise.all([client.getTransaction({ hash }), client.getBlock({ blockNumber: receipt.blockNumber })]);
  const checks: Record<string, boolean> = {
    succeeded: receipt.status === "success", canonical: block.hash === receipt.blockHash && tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber,
    receiptBound: receipt.transactionHash.toLowerCase() === hash.toLowerCase() && receipt.from.toLowerCase() === owner.toLowerCase(),
    transactionBound: tx.hash.toLowerCase() === hash.toLowerCase(),
    ownerSender: tx.from.toLowerCase() === owner.toLowerCase(), creation: tx.to === null && receipt.to === null,
    requestNonce: expectedNonce === undefined || tx.nonce === expectedNonce,
    exactInitCode: tx.input.toLowerCase() === controlledDeploymentData(owner).toLowerCase(), zeroValue: tx.value === 0n,
    predictedAddress: receipt.contractAddress?.toLowerCase() === getContractAddress({ from: owner, nonce: BigInt(tx.nonce) }).toLowerCase(),
    runtimeMatches: false, childAddressesMatch: false, childRuntimeMatches: false, dependenciesMatch: false
  };
  let dependencies: Dependencies | undefined;
  if (Object.entries(checks).filter(([key]) => !["runtimeMatches", "childAddressesMatch", "childRuntimeMatches", "dependenciesMatch"].includes(key)).every(([, ok]) => ok)) {
    const address = receipt.contractAddress!, blockNumber = receipt.blockNumber;
    const [code, suiteOwner, ...addresses] = await Promise.all([
      client.getCode({ address, blockNumber }),
      client.readContract({ address, abi: controlledAbi, functionName: "owner", blockNumber }),
      ...(["token0", "token1", "feed0", "feed1", "router"] as const).map(functionName => client.readContract({ address, abi: controlledAbi, functionName, blockNumber }))
    ]);
    dependencies = { token0: addresses[0], token1: addresses[1], feed0: addresses[2], feed1: addresses[3], router: addresses[4] };
    const predicted = Object.fromEntries((["router", "token0", "token1", "feed0", "feed1"] as const).map((key, i) =>
      [key, getContractAddress({ from: address, nonce: BigInt(i + 1) })])) as typeof dependencies;
    checks.childAddressesMatch = Object.entries(predicted).every(([key, expected]) =>
      dependencies![key as keyof Dependencies].toLowerCase() === expected.toLowerCase());
    const artifacts = compileContracts();
    checks.runtimeMatches = code?.toLowerCase() === expectedRuntimeCode(artifacts.ControlledEnvironment, { owner, ...predicted }).toLowerCase();
    if (!checks.childAddressesMatch || !checks.runtimeMatches) return {
      state: "MISMATCH" as const, contractAddress: address, blockNumber, blockHash: receipt.blockHash, checks, dependencies
    };
    const children: { address: Address; artifact: Artifact; values: Record<string, string | number> }[] = [
      { address: predicted.router, artifact: artifacts.ControlledRouter, values: { environment: address } },
      { address: predicted.token0, artifact: artifacts.ControlledToken, values: { precision: 18 } },
      { address: predicted.token1, artifact: artifacts.ControlledToken, values: { precision: 6 } },
      { address: predicted.feed0, artifact: artifacts.ControlledFeed, values: { owner } },
      { address: predicted.feed1, artifact: artifacts.ControlledFeed, values: { owner } }
    ];
    const childCode = await Promise.all(children.map(child => client.getCode({ address: child.address, blockNumber })));
    checks.childRuntimeMatches = children.every((child, i) => childCode[i]?.toLowerCase() ===
      expectedRuntimeCode(child.artifact, child.values).toLowerCase());
    const values = await Promise.all([
      ...([dependencies.token0, dependencies.token1] as const).flatMap((token, i) => [
        client.readContract({ address: token, abi: tokenAbi, functionName: "symbol", blockNumber }),
        client.readContract({ address: token, abi: tokenAbi, functionName: "decimals", blockNumber }),
        client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [owner], blockNumber }),
        client.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [dependencies!.router], blockNumber })
      ]),
      ...([dependencies.feed0, dependencies.feed1] as const).flatMap(feed => [
        client.readContract({ address: feed, abi: feedAbi, functionName: "owner", blockNumber }),
        client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData", blockNumber })
      ]),
      ...(["token0", "token1", "environment", "controlledTestEnvironment"] as const).map(functionName =>
        client.readContract({ address: dependencies!.router, abi: routerAbi, functionName, blockNumber }))
    ]);
    checks.dependenciesMatch = suiteOwner.toLowerCase() === owner.toLowerCase() &&
      [0, 1].every(i => values[i * 4] === (i ? "AG-TEST-B" : "AG-TEST-A") && values[i * 4 + 1] === (i ? 6 : 18) &&
        values[i * 4 + 2] === parseUnits("100", i ? 6 : 18) && values[i * 4 + 3] === parseUnits("10000", i ? 6 : 18)) &&
      [0, 1].every(i => {
        const round = values[9 + i * 2] as readonly bigint[];
        return String(values[8 + i * 2]).toLowerCase() === owner.toLowerCase() && round[0] === 1n && round[1] === 100000000n &&
          round[2] === block.timestamp && round[3] === block.timestamp && round[4] === 1n;
      }) && String(values[12]).toLowerCase() === dependencies.token0.toLowerCase() &&
      String(values[13]).toLowerCase() === dependencies.token1.toLowerCase() && String(values[14]).toLowerCase() === address.toLowerCase() && values[15] === true;
  }
  checks.canonical = checks.canonical && (await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash;
  return { state: Object.values(checks).every(Boolean) ? "VERIFIED" as const : "MISMATCH" as const,
    contractAddress: receipt.contractAddress, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, checks, dependencies };
}

async function confirmedAnchor(clients: PublicClient[], blockNumber: bigint, hash: Hash) {
  return (await Promise.all(clients.map(async rpc => {
    const [block, head] = await Promise.all([rpc.getBlock({ blockNumber }), rpc.getBlockNumber({ cacheTime: 0 })]);
    return block.number === blockNumber && block.hash === hash && head >= blockNumber + 1n;
  }))).every(Boolean);
}

export async function verifyControlledEnvironment(client: PublicClient, verifier: PublicClient, owner: Address, hash: Hash, expectedNonce?: number) {
  owner = controlledOwner(owner);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash) ||
    (expectedNonce !== undefined && (!Number.isSafeInteger(expectedNonce) || expectedNonce < 0)))
    throw new Error("Deployment hash and a valid optional request nonce required");
  const [primary, independent] = await Promise.all([
    inspectControlled(client, owner, hash, expectedNonce), inspectControlled(verifier, owner, hash, expectedNonce)
  ]);
  const matchingReads = json(primary) === json(independent);
  const canonical = primary.state === "VERIFIED" && independent.state === "VERIFIED" && matchingReads ?
    await confirmedAnchor([client, verifier], primary.blockNumber, primary.blockHash) : false;
  const state = primary.state === "PENDING" || independent.state === "PENDING" ? "PENDING" :
    primary.state === "VERIFIED" && independent.state === "VERIFIED" && matchingReads && canonical ? "VERIFIED" : "MISMATCH";
  const result = { state, ...controlledDisclosure, chainId: 97, owner, transactionHash: hash,
    ...(expectedNonce === undefined ? {} : { expectedNonce }), primary, independent, matchingReads, canonical,
    verifiedAt: new Date().toISOString(), financialTransactionCreated: false };
  return { ...result, evidenceHash: `sha256:${createHash("sha256").update(json(result)).digest("hex")}` };
}
export type ControlledProof = Awaited<ReturnType<typeof verifyControlledEnvironment>>;

export function controlledVaultConfig(proof: ControlledProof, operator: unknown, mode: unknown) {
  if (proof.state !== "VERIFIED" || !proof.primary.dependencies || !proof.primary.contractAddress) throw new Error("Independently verified environment required");
  const selected = controlledOwner(operator);
  if (mode !== "OWNER_MANUAL" && mode !== "DELEGATED") throw new Error("Explicit execution mode required");
  if ((selected === proof.owner) !== (mode === "OWNER_MANUAL")) throw new Error("Owner manual mode and distinct delegated operator must be labelled honestly");
  const raw = { owner: proof.owner, operator: selected, ...proof.primary.dependencies,
    policy: { maxActionUsd: "10", maxDailyUsd: "25", targetToken0Bps: 5000, maxSlippageBps: 100, cooldownSeconds: 300, maxOracleAge: 3600 },
    publicBaseUrl: "", ...controlledDisclosure, executionMode: mode, controlledEnvironment: proof.primary.contractAddress,
    controlledDeploymentHash: proof.transactionHash };
  parseDeploymentConfig(raw);
  return raw;
}

export async function prepareControlledRefresh(client: PublicClient, verifier: PublicClient, proof: ControlledProof) {
  if (proof.state !== "VERIFIED" || !proof.primary.dependencies) throw new Error("Verified environment required");
  const block = await client.getBlock();
  if (block.number === null || !block.hash || block.timestamp < BigInt(Math.floor(Date.now() / 1000) - 120) ||
    block.timestamp > BigInt(Math.floor(Date.now() / 1000) + 30)) throw new Error("Recent chain state required");
  const abi = parseAbi(["function refresh()"]), data = encodeFunctionData({ abi, functionName: "refresh" });
  const transactions = [];
  for (const feed of [proof.primary.dependencies.feed0, proof.primary.dependencies.feed1]) {
    const reads = await Promise.all([client, verifier].map(async rpc => {
      if (await rpc.getChainId() !== 97) throw new Error("BSC testnet 97 only");
      const [code, owner, gas] = await Promise.all([
        rpc.getCode({ address: feed, blockNumber: block.number! }),
        rpc.readContract({ address: feed, abi: feedAbi, functionName: "owner", blockNumber: block.number! }),
        rpc.estimateGas({ account: proof.owner, to: feed, data, value: 0n, blockNumber: block.number! })
      ]);
      if (code?.toLowerCase() !== expectedRuntimeCode(compileContracts().ControlledFeed, { owner: proof.owner }).toLowerCase() ||
        owner.toLowerCase() !== proof.owner.toLowerCase()) throw new Error("Controlled feed mismatch");
      return { gas };
    }));
    if (json(reads[0]) !== json(reads[1])) throw new Error("Independent refresh reads disagree");
    // updatedAt can change between estimation and mining, increasing SSTORE cost.
    const gas = (reads[0].gas * 120n + 99n) / 100n;
    transactions.push({ from: proof.owner, to: feed, data, value: "0x0", chainId: "0x61", gas: `0x${gas.toString(16)}` });
  }
  if (!(await Promise.all([client, verifier].map(rpc => rpc.getBlock({ blockNumber: block.number! })))).every(b => b.hash === block.hash))
    throw new Error("Canonical anchor changed");
  return { status: "UNSIGNED_CONTROLLED_FEED_REFRESH", ...controlledDisclosure, preparedAt: Date.now(), blockNumber: block.number, blockHash: block.hash,
    transactions, financialTransactionCreated: false,
    instruction: "Two separate owner confirmations are required. Refresh only updates synthetic fixed $1 timestamps; it does not obtain market prices." };
}

// A mined, canonical, nonce-bound receipt is needed before releasing a refresh lock.
// A timeout or a missing transaction is never evidence that it is safe to resend.
export async function verifyControlledRefresh(client: PublicClient, verifier: PublicClient, proof: ControlledProof,
  hash: Hash, feed: 0 | 1, nonce: number) {
  if (proof.state !== "VERIFIED" || !proof.primary.dependencies || !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
    ![0, 1].includes(feed) || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Verified environment, hash, feed and request nonce required");
  const address = proof.primary.dependencies[feed === 0 ? "feed0" : "feed1"];
  const data = encodeFunctionData({ abi: parseAbi(["function refresh()"]), functionName: "refresh" });
  const inspect = async (rpc: PublicClient) => {
    if (await rpc.getChainId() !== 97) throw new Error("BSC testnet 97 only");
    let receipt;
    try { receipt = await rpc.getTransactionReceipt({ hash }); }
    catch (error) { if (error instanceof TransactionReceiptNotFoundError) return { state: "PENDING" as const }; throw error; }
    if ((await rpc.getBlockNumber({ cacheTime: 0 })) < receipt.blockNumber + 1n) return { state: "PENDING" as const };
    const [tx, block, code, owner] = await Promise.all([
      rpc.getTransaction({ hash }), rpc.getBlock({ blockNumber: receipt.blockNumber }),
      rpc.getCode({ address, blockNumber: receipt.blockNumber }),
      rpc.readContract({ address, abi: feedAbi, functionName: "owner", blockNumber: receipt.blockNumber })
    ]);
    const checks = {
      hashBound: receipt.transactionHash.toLowerCase() === hash.toLowerCase() && tx.hash.toLowerCase() === hash.toLowerCase(),
      sender: tx.from.toLowerCase() === proof.owner.toLowerCase() && receipt.from.toLowerCase() === proof.owner.toLowerCase(),
      destination: tx.to?.toLowerCase() === address.toLowerCase() && receipt.to?.toLowerCase() === address.toLowerCase(),
      exactCall: tx.input.toLowerCase() === data.toLowerCase() && tx.value === 0n && tx.nonce === nonce,
      canonical: block.hash === receipt.blockHash && tx.blockHash === receipt.blockHash && tx.blockNumber === receipt.blockNumber,
      feedRuntime: code?.toLowerCase() === expectedRuntimeCode(compileContracts().ControlledFeed, { owner: proof.owner }).toLowerCase(),
      feedOwner: owner.toLowerCase() === proof.owner.toLowerCase()
    };
    checks.canonical = checks.canonical && (await rpc.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash;
    return { state: Object.values(checks).every(Boolean) ? receipt.status === "success" ? "VERIFIED" as const : "REVERTED" as const : "MISMATCH" as const,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, checks };
  };
  const [primary, independent] = await Promise.all([inspect(client), inspect(verifier)]);
  const matchingReads = json(primary) === json(independent);
  const final = primary.state === "VERIFIED" || primary.state === "REVERTED";
  const canonical = final && matchingReads && primary.blockNumber !== undefined &&
    await confirmedAnchor([client, verifier], primary.blockNumber, primary.blockHash!);
  const state = primary.state === "PENDING" || independent.state === "PENDING" ? "PENDING" :
    final && matchingReads && canonical ? primary.state : "MISMATCH";
  return { state, ...controlledDisclosure, transactionHash: hash, feed, nonce, primary, independent, matchingReads, canonical,
    financialTransactionCreated: false };
}
