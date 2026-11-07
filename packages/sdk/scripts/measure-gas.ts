// Measures the least gas each action needs on Mezo testnet, by bisecting the gas of an eth_call at one pinned block.
// Nothing is sent. The deployer key is read from .env only to sign a permit message for one eth_call, never printed.
//
//   cd packages && npx tsx sdk/scripts/measure-gas.ts            # writes docs/gas-measurements.json
//
// Why this and not receipts: Mezo charges at least half of the gas limit, so every receipt gasUsed in
// docs/roundtrip.json is exactly half its limit and says nothing about what the call needs. An eth_call with a
// chosen gas limit does not have that floor, so the smallest limit it succeeds with is the true minimum.
//
// Calls that need MUSD, an allowance, a surplus, or a lower market rate than the position has are run against a
// state override (what eth_call allows): the override only supplies a precondition, it does not change what the
// contract does with it. The block is pinned, so every probe of one action sees the same state and timestamp.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, hashDomain, http, keccak256, pad, parseAbi, toHex,
  type Address, type Hex, type PublicClient, type StateOverride,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTrozu, matsnet, nicrOf, type UnsignedTx } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const E = 10n ** 18n;
const CAP = 9_500_000;

const client = createPublicClient({ transport: http(matsnet.rpcUrl, { retryCount: 6, retryDelay: 700, timeout: 25_000 }) }) as PublicClient;
const trozu = createTrozu({ client });

const word = (n: bigint): Hex => pad(toHex(n), { size: 32 });
const slotOfMapping = (key: Hex, slot: bigint): Hex => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
const allowanceSlot = (owner: Hex, spender: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, slotOfMapping(owner, 1n)]));
const withMusd = (owner: Hex, spender: Hex | undefined, amount: bigint): StateOverride => [
  {
    address: matsnet.mezo.musd,
    stateDiff: [{ slot: slotOfMapping(owner, 0n), value: word(amount) }, ...(spender ? [{ slot: allowanceSlot(owner, spender), value: word(amount) }] : [])],
  },
];

function envKey(name: string): Hex {
  const line = readFileSync(join(root, ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`${name} is not in .env`);
  const raw = line.slice(name.length + 1).trim().replace(/^"|"$/g, "");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

/** An answer from the node that says the call itself failed, as opposed to the request failing to arrive. */
function isExecutionFailure(e: unknown): boolean {
  const names: string[] = [];
  let cur = e as { name?: string; cause?: unknown } | undefined;
  while (cur) {
    if (cur.name) names.push(cur.name);
    cur = cur.cause as typeof cur;
  }
  return !names.some((n) => /HttpRequestError|TimeoutError|WebSocket|RpcRequestError.*limit/i.test(n)) && names.some((n) => /ExecutionRevertedError|CallExecutionError|ContractFunctionExecutionError|RpcRequestError|InternalRpcError|InvalidInputRpcError|Execution/i.test(n));
}

interface Probe { ok: boolean; why?: string }

async function bisect(label: string, tx: UnsignedTx, from: Address, block: bigint, override?: StateOverride): Promise<{ min: number; failedBelow: string; atCap: boolean }> {
  const probe = async (gas: number): Promise<Probe> => {
    try {
      await client.call({ account: from, to: tx.to, data: tx.data, value: tx.value, gas: BigInt(gas), blockNumber: block, stateOverride: override });
      return { ok: true };
    } catch (e) {
      if (!isExecutionFailure(e)) throw e; // a dropped connection must not be read as "needs more gas"
      return { ok: false, why: String((e as Error).message ?? "").split("\n")[0]?.slice(0, 140) };
    }
  };
  const top = await probe(CAP);
  if (!top.ok) throw new Error(`${label} fails even at ${CAP} gas: ${top.why}`);
  let lo = 21_000; // intrinsic gas alone, never enough for a contract call
  let hi = CAP;
  let why = "";
  while (hi - lo > 250) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await probe(mid);
    if (r.ok) hi = mid;
    else {
      lo = mid;
      why = r.why ?? "";
    }
  }
  // the bisection assumes more gas never hurts; check a few steps either side of the answer
  for (const g of [hi + 2_000, hi + 20_000]) if (!(await probe(g)).ok) throw new Error(`${label}: succeeds at ${hi} but not at ${g}, not monotonic`);
  return { min: hi, failedBelow: why, atCap: true };
}

const results: Record<string, unknown> = {};
const log = (name: string, r: { min: number }, note: string) => {
  results[name] = { minGas: r.min, note };
  console.log(`${name.padEnd(24)} ${String(r.min).padStart(9)}  ${note}`);
};

async function main() {
  const head = await client.getBlockNumber();
  const block = head - 3n;
  const pinned = await client.getBlock({ blockNumber: block });
  console.log(`pinned block ${block} (head ${head}), timestamp ${pinned.timestamp}`);

  const vault = await trozu.vaultOf(1n);
  const pos = await trozu.lens.position(1n);
  const holder = pos.holder as Address;
  console.log(`position 1: vault ${vault}, holder ${holder}, ratio ${pos.risk}`);

  // ---- calibration: actions whose gas is known from a plain receipt, to prove the method gives the right order of magnitude
  const calibrate: Record<string, unknown> = {};
  {
    const approve = { to: matsnet.mezo.musd as Address, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256) returns (bool)"]), args: [matsnet.trozu.market, 10n * E] }), value: 0n } as UnsignedTx;
    const r = await bisect("calibrate approve", approve, holder, block);
    calibrate.approveMusd = { measured: r.min, receipt: 46_242 };
    console.log(`calibrate approve (MUSD)  ${r.min}  (receipt in proof.json: 46,242)`);
    const open = await trozu.market.listings({ tokenId: 1n, onlyOpen: true, lookbackBlocks: 60_000 });
    const live = open[0];
    if (live) {
      const cancel = trozu.tx.cancel({ listing: live.listing });
      const rc = await bisect("calibrate cancel", cancel, holder, block);
      calibrate.cancel = { measured: rc.min, receipt: 49_507 };
      console.log(`calibrate cancel          ${rc.min}  (receipt in proof.json: 49,507)`);
      const ann = trozu.tx.announce({ listing: live.listing, signature: live.signature });
      const ra = await bisect("calibrate announce", ann, holder, block);
      calibrate.announce = { measured: ra.min, receipt: 99_293 };
      console.log(`calibrate announce        ${ra.min}  (receipt in proof.json: 99,293)`);
    }
    const transfer = trozu.tx.transferPosition({ from: holder, to: "0xf8B5CF0292C4e5202CC9a9e6041FD59F692edEe2", tokenId: 1n });
    const rt = await bisect("calibrate transfer", transfer, holder, block);
    calibrate.safeTransferFrom = { measured: rt.min, receipt: 86_373 };
    console.log(`calibrate safeTransferFrom ${rt.min}  (receipt in proof.json: 86,373)`);
  }
  results.calibration = calibrate;

  // ---- hints exactly as the app computes them, for the actions that re-sort the trove
  const repayAmount = 5n * E; // the position is about 11 MUSD above Mezo's minimum net debt, so a repay has to be small
  const nicrAfterRepay = nicrOf(pos.collateral, pos.principal - repayAmount)!;
  const [up, lo] = await trozu.hints(nicrAfterRepay, 7n);
  const hints = [up, lo] as const;
  const balanceAndAllowance = withMusd(holder, vault, 10_000n * E);

  // repay
  log("repay", await bisect("repay", trozu.tx.repay({ vault, amount: repayAmount, hints }), holder, block, balanceAndAllowance), "5 MUSD, hints from Mezo's HintHelpers, MUSD balance and allowance overridden");

  // the same call with no hints: Mezo walks the sorted list from its head, which is what a caller that skips hints pays
  log("repay (no hints)", await bisect("repay no hints", trozu.tx.repay({ vault, amount: repayAmount }), holder, block, balanceAndAllowance), "5 MUSD, hints left out, MUSD balance and allowance overridden");

  // refinance: the position has to be at a higher rate than the market. Find where the vault reads the market rate and lower it.
  {
    const irm = matsnet.mezo.interestRateManager as Address;
    const rateAbi = parseAbi(["function interestRate() view returns (uint16)"]);
    const current = await client.readContract({ address: irm, abi: rateAbi, functionName: "interestRate", blockNumber: block });
    let found: bigint | undefined;
    for (let s = 0n; s < 40n && found === undefined; s++) {
      const raw = BigInt(await client.getStorageAt({ address: irm, slot: toHex(s, { size: 32 }), blockNumber: block }) ?? "0x0");
      if ((raw & 0xffffn) !== BigInt(current)) continue;
      const mask = ~0xffffn & ((1n << 256n) - 1n);
      const patched = (raw & mask) | 50n;
      const via = await client.readContract({ address: irm, abi: rateAbi, functionName: "interestRate", blockNumber: block, stateOverride: [{ address: irm, stateDiff: [{ slot: toHex(s, { size: 32 }), value: word(patched) }] }] });
      if (via === 50) found = s;
    }
    if (found === undefined) throw new Error("could not find the interest rate slot");
    const rateRaw = BigInt(await client.getStorageAt({ address: irm, slot: toHex(found, { size: 32 }), blockNumber: block }) ?? "0x0");
    const lowerRate: StateOverride = [{ address: irm, stateDiff: [{ slot: toHex(found, { size: 32 }), value: word((rateRaw & (~0xffffn & ((1n << 256n) - 1n))) | 50n) }] }];
    const refiNicr = nicrOf(pos.collateral, pos.principal)!;
    const [ru, rl] = await trozu.hints(refiNicr, 11n);
    log("refinance", await bisect("refinance", trozu.tx.refinance({ vault, maxFee: 50n * E, hints: [ru, rl] }), holder, block, lowerRate), `market rate overridden from ${current} to 50 bps (storage slot ${found}) so the position's rate is the higher one`);
    log("refinance (no hints)", await bisect("refinance no hints", trozu.tx.refinance({ vault, maxFee: 50n * E }), holder, block, lowerRate), "same override, hints left out");
  }

  // close and closeWithPermit
  log("close", await bisect("close", trozu.tx.close({ vault }), holder, block, balanceAndAllowance), "MUSD balance and allowance overridden");
  {
    // the vault asks MUSD for a permit of exactly debt - 200 at execution; at a pinned block the timestamp does not move, so that number is exact
    const deployerKey = envKey("DEPLOYER_PRIVATE_KEY");
    const account = privateKeyToAccount(deployerKey);
    if (account.address.toLowerCase() !== holder.toLowerCase()) throw new Error("the deployer key is not the holder of position 1");
    const musdAbi = parseAbi(["function name() view returns (string)", "function nonces(address) view returns (uint256)", "function DOMAIN_SEPARATOR() view returns (bytes32)", "function version() view returns (string)"]);
    const [name, nonce, separator] = await Promise.all([
      client.readContract({ address: matsnet.mezo.musd, abi: musdAbi, functionName: "name", blockNumber: block }),
      client.readContract({ address: matsnet.mezo.musd, abi: musdAbi, functionName: "nonces", args: [holder], blockNumber: block }),
      client.readContract({ address: matsnet.mezo.musd, abi: musdAbi, functionName: "DOMAIN_SEPARATOR", blockNumber: block }),
    ]);
    let version = "1";
    for (const v of ["1", "2"]) if (hashDomain({ domain: { name, version: v, chainId: BigInt(matsnet.chainId), verifyingContract: matsnet.mezo.musd }, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } }) === separator) version = v;
    const debtAbi = parseAbi(["function getEntireDebtAndColl(address) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)"]);
    const [, principal, interest, , pendingPrincipal, pendingInterest] = await client.readContract({ address: matsnet.mezo.troveManager, abi: debtAbi, functionName: "getEntireDebtAndColl", args: [vault], blockNumber: block });
    const cost = principal + interest + pendingPrincipal + pendingInterest - 200n * E;
    const deadline = pinned.timestamp + 3600n;
    const sig = await account.signTypedData({
      domain: { name, version, chainId: matsnet.chainId, verifyingContract: matsnet.mezo.musd },
      types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Permit",
      message: { owner: holder, spender: vault, value: cost, nonce, deadline },
    });
    const r = `0x${sig.slice(2, 66)}` as Hex, s = `0x${sig.slice(66, 130)}` as Hex, v = Number(`0x${sig.slice(130, 132)}`);
    // balance only: a valid permit sets the allowance itself, which is the cost this measures
    const tx = trozu.tx.closeWithPermit({ vault, permit: { deadline, v, r, s } });
    log("closeWithPermit", await bisect("closeWithPermit", tx, holder, block, withMusd(holder, undefined, 10_000n * E)), `valid permit signed for the exact cost at the pinned block (domain version ${version}), MUSD balance overridden`);
  }

  // claimSurplus: put a claimable balance in Mezo's surplus pool for the vault
  {
    const pool = matsnet.mezo.collSurplusPool as Address;
    const amount = 5n * 10n ** 15n;
    const poolAbi = parseAbi(["function getCollateral(address) view returns (uint256)"]);
    const ov: StateOverride = [{ address: pool, balance: 10n * amount, stateDiff: [{ slot: toHex(3n, { size: 32 }), value: word(10n * amount) }, { slot: slotOfMapping(vault, 4n), value: word(amount) }] }];
    const seen = await client.readContract({ address: pool, abi: poolAbi, functionName: "getCollateral", args: [vault], blockNumber: block, stateOverride: ov });
    if (seen !== amount) throw new Error("the surplus pool slot guess is wrong");
    log("claimSurplus", await bisect("claimSurplus", trozu.tx.claimSurplus({ vault }), holder, block, ov), "0.005 BTC placed in the surplus pool's balances slot 4, its total in slot 3, and its BTC balance");
  }

  log("fundReserveMusd", await bisect("fundReserveMusd", trozu.tx.fundReserveMusd({ vault, amount: 100n * E }), holder, block, balanceAndAllowance), "100 MUSD, MUSD balance and allowance overridden");
  log("clearPolicy", await bisect("clearPolicy", trozu.tx.clearPolicy({ vault }), holder, block), "the live policy of position 1, no override");
  log("cancelAll", await bisect("cancelAll", trozu.tx.cancelAll(), holder, block), "no override");
  {
    const data = encodeFunctionData({ abi: parseAbi(["function setApprovalForAll(address,bool)"]), args: [matsnet.trozu.market, true] });
    log("setApprovalForAll", await bisect("setApprovalForAll", { to: matsnet.trozu.nft as Address, data, value: 0n } as UnsignedTx, holder, block), "approve the market for all of the holder's NFTs, no override");
  }

  const out = { measuredAt: new Date().toISOString(), chainId: matsnet.chainId, block: block.toString(), method: "smallest eth_call gas limit that succeeds, bisected to within 250 gas, then checked at +2,000 and +20,000", ...results };
  writeFileSync(join(root, "docs", "gas-measurements.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("wrote docs/gas-measurements.json");
}

main().catch((e) => {
  console.error(String(e?.message ?? e).split("\n")[0]);
  process.exit(1);
});
