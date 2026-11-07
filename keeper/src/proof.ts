#!/usr/bin/env tsx
// One-command live proof on Mezo testnet. Runs the whole Trozu lifecycle against the deployed
// Wave 2 contracts and writes docs/PROOF.md (for people) and docs/proof.json (for the app), each
// step with its transaction hash.
//
//   npm run proof                  # refuses if a proof already exists
//   npm run proof -- --resume      # continue an interrupted run, skipping finished steps
//   npm run proof -- --fresh       # start over (opens a NEW position, spends BTC again)
//   npm run proof -- --check       # read only: balances, price, sizing; sends nothing
//
// Keys come from the environment only and are never printed:
//   DEPLOYER_PRIVATE_KEY  holder, seller, fee recipient
//   SECOND_PRIVATE_KEY    the second wallet (buyer)
//   KEEPER_PRIVATE_KEY    the keeper
//
// The oracle cannot be moved on testnet, so the guardian steps set the policy floor just above the
// position's current ratio. The keeper then acts legitimately: the contract's own planner says so.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodePacked,
  hashTypedData,
  keccak256,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type Abi,
  type PublicClient,
} from "viem";

import { REPO_ROOT, keyFromEnv, loadAbi, loadConfig, makeClients, realChain } from "./chain.js";
import { runOnce } from "./keeper.js";
import { Hex, KIND_NAMES, REASON_NAMES } from "./types.js";

const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const PROOF_JSON = resolve(REPO_ROOT, "docs/proof.json");
const PROOF_MD = resolve(REPO_ROOT, "docs/PROOF.md");

const LISTING_STATES = ["Ok", "Filled", "Cancelled", "BadParams", "NotStarted", "Expired", "NonceRevoked", "BadSignature", "NotOwner", "NotApproved", "StaleEpoch", "TroveInactive", "NoCollateral"];

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function nonces(address) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const priceFeedAbi = parseAbi(["function fetchPrice() view returns (uint256)"]);
const boAbi = parseAbi(["function getBorrowingFee(uint256) view returns (uint256)", "function minNetDebt() view returns (uint256)"]);
const hintAbi = parseAbi(["function getApproxHint(uint256,uint256,uint256) view returns (address,uint256,uint256)"]);
const sortedAbi = parseAbi(["function findInsertPosition(uint256,address,address) view returns (address,address)", "function getSize() view returns (uint256)"]);
const HINT_HELPERS = "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6" as Hex; // see web/src/config/deployment.json

interface Step {
  n: number;
  name: string;
  title: string;
  actor?: string;
  tx?: Hex;
  block?: number;
  gasUsed?: string;
  note?: string;
  data?: Record<string, unknown>;
}
interface Refusal {
  name: string;
  what: string;
  contract: Hex;
  call: string;
  revert: string;
  args: string[];
  raw: string;
}
interface State {
  startedAt: string;
  finishedAt?: string;
  chainId: number;
  explorer: string;
  contracts: Record<string, string>;
  wallets: Record<string, string>;
  balances: { before?: Record<string, string>; after?: Record<string, string> };
  steps: Step[];
  refusals: Refusal[];
  ctx: Record<string, string>;
  notes: string[];
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: bigint, d = 6) => (Number(n) / 1e18).toFixed(d);

async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const dKey = keyFromEnv("DEPLOYER_PRIVATE_KEY");
  const wKey = keyFromEnv("SECOND_PRIVATE_KEY");
  const kKey = keyFromEnv("KEEPER_PRIVATE_KEY");
  if (!dKey || !wKey || !kKey) throw new Error("DEPLOYER_PRIVATE_KEY, SECOND_PRIVATE_KEY and KEEPER_PRIVATE_KEY must all be set");

  const D = makeClients(cfg, dKey);
  const W = makeClients(cfg, wKey);
  const K = makeClients(cfg, kKey);
  const pub: PublicClient = D.publicClient;
  const dAddr = D.account!.address;
  const wAddr = W.account!.address;
  const kAddr = K.account!.address;

  const factoryAbi = loadAbi(cfg, "factory");
  const nftAbi = loadAbi(cfg, "nft");
  const vaultAbi = loadAbi(cfg, "vault");
  const marketAbi = loadAbi(cfg, "market");
  const lensAbi = loadAbi(cfg, "lens");
  const { factory, nft, lens, market } = cfg.trozu;
  const { musd, priceFeed, borrowerOperations, sortedTroves } = cfg.mezo;

  const read = <T>(address: Hex, abi: Abi | readonly unknown[], functionName: string, a: unknown[] = []) =>
    pub.readContract({ address, abi: abi as Abi, functionName, args: a } as never) as Promise<T>;
  const musdOf = (a: Hex) => read<bigint>(musd, erc20, "balanceOf", [a]);
  const btcOf = (a: Hex) => pub.getBalance({ address: a });
  const snapshot = async () => ({
    deployerBtc: String(await btcOf(dAddr)), secondBtc: String(await btcOf(wAddr)), keeperBtc: String(await btcOf(kAddr)),
    deployerMusd: String(await musdOf(dAddr)), secondMusd: String(await musdOf(wAddr)),
  });

  // ---------------------------------------------------------------- sizing (read only)
  const price = await read<bigint>(priceFeed, priceFeedAbi, "fetchPrice");
  const DEBT = parseUnits("1800", 18); // Mezo's minimum net debt, so the smallest possible position
  const fee = await read<bigint>(borrowerOperations, boAbi, "getBorrowingFee", [DEBT]);
  const composite = DEBT + fee + 200n * WAD;
  const TARGET_ICR = parseUnits("1.35", 18);
  const coll = (composite * TARGET_ICR + price - 1n) / price;
  const reserveBtc = parseUnits("0.0065", 18);
  const funding = (await btcOf(dAddr));
  console.log(`price ${fmt(price, 2)} USD | position ${fmt(coll)} BTC at 135% | guardian reserve ${fmt(reserveBtc)} BTC | deployer ${fmt(funding)} BTC`);
  if (args.includes("--check")) {
    console.log(json(await snapshot()));
    return;
  }

  // ---------------------------------------------------------------- state and resume
  let state: State;
  if (existsSync(PROOF_JSON)) {
    if (args.includes("--resume")) state = JSON.parse(readFileSync(PROOF_JSON, "utf8")) as State;
    else if (args.includes("--fresh")) state = fresh();
    else throw new Error("docs/proof.json exists. Use --resume to continue it, or --fresh to start over (that opens a new position).");
  } else state = fresh();
  function fresh(): State {
    return {
      startedAt: new Date().toISOString(), chainId: cfg.chainId, explorer: cfg.explorer, contracts: { ...cfg.trozu },
      wallets: { deployer: dAddr, second: wAddr, keeper: kAddr, feeRecipient: cfg.market.feeRecipient },
      balances: {}, steps: [], refusals: [], ctx: {}, notes: [],
    };
  }
  const save = () => writeFileSync(PROOF_JSON, json(state) + "\n");
  // the funds gate applies to a fresh run only: on --resume most of the BTC is already spent
  if (state.steps.length === 0) {
    const needed = coll + reserveBtc + 3n * 10n ** 15n;
    if (funding < needed) throw new Error(`deployer holds ${fmt(funding)} BTC, the run needs about ${fmt(needed)} including the 0.003 reserve`);
  }
  if (!state.balances.before) state.balances.before = await snapshot();
  save();

  const link = (tx: Hex) => `${cfg.explorer}/tx/${tx}`;
  const stepOf = (name: string) => state.steps.find((s) => s.name === name);

  /** Run one named step once. A tx step records its hash immediately, so a resume never repeats it. */
  async function step(name: string, title: string, actor: string, fn: () => Promise<{ tx?: Hex; note?: string; data?: Record<string, unknown>; receipt?: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>> }>): Promise<Step> {
    const done = stepOf(name);
    if (done) { console.log(`  [skip] ${title}`); return done; }
    console.log(`  ${title} ...`);
    const r = await fn();
    const s: Step = { n: state.steps.length + 1, name, title, actor, tx: r.tx ?? r.receipt?.transactionHash, block: r.receipt ? Number(r.receipt.blockNumber) : undefined, gasUsed: r.receipt ? String(r.receipt.gasUsed) : undefined, note: r.note, data: r.data };
    state.steps.push(s);
    save();
    console.log(`    ${s.tx ? link(s.tx) : "(no transaction)"}${r.note ? " | " + r.note : ""}`);
    return s;
  }

  type Who = typeof D;
  /** A transaction. Simulated first (so a refusal costs nothing), and never resent blindly. */
  async function send(who: Who, p: { address: Hex; abi: Abi | readonly unknown[]; functionName: string; args?: unknown[]; value?: bigint }) {
    const account = who.account!;
    await pub.simulateContract({ ...p, account, abi: p.abi as Abi } as never);
    // The node's eth_estimateGas has returned absurdly low numbers (about 21,300 for a call that
    // needs 5.6M, and a limit under the data-gas floor), so never trust it alone: use the larger of
    // 1.3x the estimate and 6M. Mezo charges at least half of the gas limit (checked 2026-11-07: a plain self-send with a 1M limit was charged 500,000 gas), so a generous limit is cheap, not free: 6M costs about 3M gas, under 0.000000001 BTC at the 292 wei seen.
    let est = 0n;
    try { est = await pub.estimateContractGas({ ...p, account, abi: p.abi as Abi } as never); } catch { /* the floor covers it */ }
    const gas = est * 13n / 10n > 6_000_000n ? (est * 13n / 10n > 9_500_000n ? 9_500_000n : est * 13n / 10n) : 6_000_000n;
    const before = await pub.getTransactionCount({ address: account.address });
    try {
      const hash = await who.walletClient!.writeContract({ ...p, gas, account, chain: who.chain, abi: p.abi as Abi } as never);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 150_000 });
      if (receipt.status !== "success") throw new Error(`reverted on chain: ${hash}`);
      return receipt;
    } catch (e) {
      const after = await pub.getTransactionCount({ address: account.address });
      if (after !== before) console.error("    the nonce moved, so the transaction may have landed. Check before using --resume.");
      throw e;
    }
  }

  /** An eth_call that is expected to revert. The real revert reason goes into the proof. */
  async function refuse(name: string, what: string, who: Who, contract: Hex, abi: Abi | readonly unknown[], functionName: string, a: unknown[], value?: bigint) {
    if (state.refusals.find((r) => r.name === name)) return;
    try {
      await pub.simulateContract({ address: contract, abi: abi as Abi, functionName, args: a, account: who.account!, value } as never);
      throw new Error(`REFUSAL EXPECTED BUT CALL SUCCEEDED: ${name}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("REFUSAL EXPECTED")) throw e;
      const r = e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
      if (!r) throw new Error(`${name}: the call failed without a contract revert: ${e instanceof Error ? e.message : e}`);
      const argStrs = (r.data?.args ?? []).map((x) => String(x));
      let revert = r.data?.errorName ?? "unknown";
      if (revert === "ListingInvalid") revert += `(${LISTING_STATES[Number(argStrs[0])] ?? argStrs[0]})`;
      else if (revert === "NothingToDo") revert += `(${REASON_NAMES[Number(argStrs[0])] ?? argStrs[0]})`;
      else if (argStrs.length) revert += `(${argStrs.join(", ")})`;
      state.refusals.push({ name, what, contract, call: functionName, revert, args: argStrs, raw: r.raw ?? "" });
      save();
      console.log(`  refused: ${what} -> ${revert}`);
    }
  }

  // ---------------------------------------------------------------- helpers for the market
  const block = () => pub.getBlock();
  const domain = { name: "TrozuMarket", version: "1", chainId: cfg.chainId, verifyingContract: market } as const;
  const types = {
    Listing: [
      { name: "seller", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "epoch", type: "uint256" },
      { name: "startPrice", type: "uint256" }, { name: "endPrice", type: "uint256" }, { name: "startTime", type: "uint64" },
      { name: "endTime", type: "uint64" }, { name: "deadline", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "salt", type: "uint256" },
    ],
  } as const;
  type Listing = { seller: Hex; tokenId: bigint; epoch: bigint; startPrice: bigint; endPrice: bigint; startTime: bigint; endTime: bigint; deadline: bigint; nonce: bigint; salt: bigint };
  const ser = (l: Listing) => json(l);
  const de = (s: string): Listing => { const o = JSON.parse(s); return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === "seller" ? v : BigInt(v as string)])) as unknown as Listing; };

  async function sign(who: Who, l: Listing) {
    const sig = await who.account!.signTypedData({ domain, types, primaryType: "Listing", message: l } as never);
    const onchain = await read<Hex>(market, marketAbi, "hashListing", [l]);
    if (onchain !== hashTypedData({ domain, types, primaryType: "Listing", message: l } as never)) throw new Error("typed data hash differs from the contract's");
    return sig;
  }
  async function newListing(seller: Hex, kind: "fixed" | "dutch" | "short", price: bigint, salt: bigint, endPrice?: bigint): Promise<Listing> {
    const b = await block();
    const ts = b.timestamp;
    return {
      seller, tokenId: BigInt(state.ctx.id), epoch: await read<bigint>(nft, nftAbi, "transferEpoch", [BigInt(state.ctx.id)]),
      startPrice: price, endPrice: kind === "dutch" ? endPrice! : price,
      startTime: kind === "dutch" ? ts : 0n, endTime: kind === "dutch" ? ts + 900n : 0n,
      deadline: kind === "short" ? ts + 45n : ts + 86_400n,
      nonce: await read<bigint>(market, marketAbi, "sellerNonce", [seller]), salt,
    };
  }
  async function bounds(over: Partial<Record<string, bigint | number>> = {}) {
    const [c, p, i] = await read<readonly [bigint, bigint, bigint]>(cfg.mezo.troveManager, parseAbi(["function getEntireDebtAndColl(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]), "getEntireDebtAndColl", [state.ctx.vault as Hex]);
    return {
      expectedEpoch: BigInt(state.ctx.epochAtList ?? "0"), minColl: c, maxDebt: p + i + 5n * WAD, minRateBps: 0, maxRateBps: 10_000,
      maxPrice: parseUnits("1000", 18), minReserveBtc: 0n, minReserveMusd: 0n, ...over,
    };
  }
  const lensInfo = () => read<Record<string, any>>(lens, lensAbi, "positionInfo", [BigInt(state.ctx.id)]);
  const sold = (r: { logs: readonly unknown[] }) => parseEventLogs({ abi: marketAbi, logs: r.logs as never, eventName: "Sold" })[0]?.args as { price: bigint; fee: bigint; buyer: Hex; seller: Hex } | undefined;

  const ID = () => BigInt(state.ctx.id);
  const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
  const noPermit = { deadline: 0n, v: 0, r: ZERO32, s: ZERO32 };
  const defaultPolicy = (over: Record<string, unknown>) => ({
    epoch: 0n, floorIcr: 0n, targetIcr: 0n, maxActionBtc: parseUnits("0.004", 18), maxActionMusd: 0n,
    periodCapBtc: parseUnits("0.01", 18), periodCapMusd: 0n, keeperTipBtc: 10n ** 13n, bufferFloorMusd: 0n,
    period: 86_400, maxWalkSteps: 0, active: false, ...over,
  });

  console.log("Trozu live proof on Mezo testnet");

  // ================================================================ 0. fund the buyer
  await step("fund-buyer", "Fund the second wallet with 400 MUSD", "deployer", async () => {
    const receipt = await send(D, { address: musd, abi: erc20, functionName: "transfer", args: [wAddr, parseUnits("400", 18)] });
    return { receipt, note: "MUSD moved from the deployer; the buyer needs it for the two sales" };
  });

  // ================================================================ 1. open a v2 position
  await step("open", "Open a v2 position at about 135%", "deployer", async () => {
    const nicr = (coll * 10n ** 20n) / composite;
    const [approx] = await read<readonly [Hex, bigint, bigint]>(HINT_HELPERS, hintAbi, "getApproxHint", [nicr, 50n, BigInt(Math.floor(Math.random() * 1_000_000))]);
    const [upper, lower] = await read<readonly [Hex, Hex]>(sortedTroves, sortedAbi, "findInsertPosition", [nicr, approx, approx]);
    const receipt = await send(D, { address: factory, abi: factoryAbi, functionName: "openPosition", args: [DEBT, upper, lower, fee + fee / 20n + 1n], value: coll });
    const ev = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: "PositionCreated" })[0] as unknown as { args: { tokenId: bigint; vault: Hex } };
    state.ctx.id = String(ev.args.tokenId);
    state.ctx.vault = ev.args.vault as string;
    const info = await lensInfo();
    return { receipt, note: `token ${ev.args.tokenId}, vault ${ev.args.vault}, ratio ${(Number(info.icr) / 1e16).toFixed(2)}%`, data: { tokenId: String(ev.args.tokenId), vault: ev.args.vault, coll: String(coll), debt: String(DEBT) } };
  });
  const vault = state.ctx.vault as Hex;
  if (!vault) throw new Error("no vault in state; the open step has not completed");

  // a guardian policy BEFORE any transfer, so we can show it die
  await step("policy-before-transfer", "Set a guardian policy (it should not survive the transfers)", "deployer", async () => {
    const info = await lensInfo();
    const p = defaultPolicy({ floorIcr: info.icr + parseUnits("0.04", 18), targetIcr: info.icr + parseUnits("0.10", 18) });
    const receipt = await send(D, { address: vault, abi: vaultAbi, functionName: "setPolicy", args: [p] });
    return { receipt, note: "policy stamped with the token's current transfer epoch" };
  });

  // a listing signed now, before the transfers, kept unannounced for the stale-epoch refusal
  if (!state.ctx.staleListing) {
    await step("approve-market", "Approve the market on the NFT", "deployer", async () => ({
      receipt: await send(D, { address: nft, abi: nftAbi, functionName: "setApprovalForAll", args: [market, true] }),
    }));
    const l = await newListing(dAddr, "fixed", parseUnits("100", 18), 900n);
    state.ctx.staleListing = ser(l);
    state.ctx.staleSig = await sign(D, l);
    save();
  }

  // ================================================================ 2. transfer away and back
  await step("transfer-out", "Transfer the position to the second wallet", "deployer", async () => {
    const receipt = await send(D, { address: nft, abi: nftAbi, functionName: "transferFrom", args: [dAddr, wAddr, ID()] });
    return { receipt, note: "collateral, debt and locked rate moved as one object" };
  });
  await refuse("old-holder", "the old holder tries to withdraw collateral after the transfer", D, vault, vaultAbi, "withdrawCollateral", [10n ** 12n, ZERO, ZERO]);
  await step("transfer-back", "The second wallet transfers it back", "second", async () => ({
    receipt: await send(W, { address: nft, abi: nftAbi, functionName: "transferFrom", args: [wAddr, dAddr, ID()] }),
  }));
  await refuse("stale-policy", "a keeper tries the policy that was set before the two transfers", K, vault, vaultAbi, "execute", [ZERO, ZERO]);
  {
    const l = de(state.ctx.staleListing);
    const b = await bounds({ expectedEpoch: l.epoch });
    await refuse("stale-epoch", "buying a listing signed before the position moved away and back", W, market, marketAbi, "buy", [l, state.ctx.staleSig, b, wAddr, noPermit]);
  }

  // ================================================================ 3. list, announce, buy (fixed price, with permit)
  if (!state.ctx.l1) {
    const l = await newListing(dAddr, "fixed", parseUnits("100", 18), 1n);
    state.ctx.l1 = ser(l);
    state.ctx.l1sig = await sign(D, l);
    state.ctx.epochAtList = String(l.epoch);
    save();
  }
  const l1 = de(state.ctx.l1);
  await step("announce-1", "Announce a fixed-price listing (100 MUSD) as an event", "deployer", async () => {
    const receipt = await send(D, { address: market, abi: marketAbi, functionName: "announce", args: [l1, state.ctx.l1sig] });
    const ev = parseEventLogs({ abi: marketAbi, logs: receipt.logs, eventName: "ListingAnnounced" })[0] as unknown as { args: { hash: Hex } };
    return { receipt, note: `ListingAnnounced hash ${ev.args.hash}`, data: { hash: ev.args.hash, listing: JSON.parse(ser(l1)), signature: state.ctx.l1sig } };
  });
  await step("buy-fixed", "The second wallet buys it for 100 MUSD (permit, no prior approval)", "second", async () => {
    const deadline = (await block()).timestamp + 3600n;
    const value = parseUnits("1000", 18);
    const nonce = await read<bigint>(musd, erc20, "nonces", [wAddr]);
    const ds = await read<Hex>(musd, erc20, "DOMAIN_SEPARATOR");
    const typeHash = keccak256(encodePacked(["string"], ["Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"]));
    const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [typeHash, wAddr, market, value, nonce, deadline]));
    const digest = keccak256(encodePacked(["bytes2", "bytes32", "bytes32"], ["0x1901", ds, structHash]));
    const sig = await W.account!.sign!({ hash: digest });
    const v = Number(`0x${sig.slice(130, 132)}`);
    const permit = { deadline, v, r: `0x${sig.slice(2, 66)}` as Hex, s: `0x${sig.slice(66, 130)}` as Hex };
    const recipientBefore = await musdOf(cfg.market.feeRecipient as Hex);
    const b = await bounds({ maxPrice: value });
    const receipt = await send(W, { address: market, abi: marketAbi, functionName: "buy", args: [l1, state.ctx.l1sig, b, wAddr, permit] });
    const s = sold(receipt);
    const transfers = parseEventLogs({ abi: erc20, logs: receipt.logs, eventName: "Transfer" }).filter((t) => t.address.toLowerCase() === musd.toLowerCase());
    const toRecipient = transfers.filter((t) => t.args.to.toLowerCase() === cfg.market.feeRecipient.toLowerCase()).map((t) => String(t.args.value));
    if (!s || s.price !== parseUnits("100", 18) || s.fee !== parseUnits("0.25", 18)) throw new Error("unexpected sale amounts");
    if (!toRecipient.includes(String(s.fee))) throw new Error("the fee transfer to the recipient was not found in the receipt");
    const owner = await read<Hex>(nft, nftAbi, "ownerOf", [ID()]);
    if (owner.toLowerCase() !== wAddr.toLowerCase()) throw new Error("the buyer does not own the position");
    return {
      receipt,
      note: `paid ${fmt(s.price, 2)} MUSD, fee ${fmt(s.fee, 4)} MUSD (25 bps) reached the recipient. The seller is also the fee recipient on this deployment, so the seller's net is price minus fee plus fee; the MUSD Transfer logs show both legs`,
      data: { price: String(s.price), fee: String(s.fee), musdTransfersToFeeRecipient: toRecipient, feeRecipientMusdBefore: String(recipientBefore), buyer: wAddr },
    };
  });
  // the old holder (deployer) is refused now that the buyer owns it: a bounds check on a live listing comes later
  await refuse("old-holder-after-sale", "the seller tries to move collateral after the sale", D, vault, vaultAbi, "withdrawCollateral", [10n ** 12n, ZERO, ZERO]);
  await step("transfer-back-2", "The second wallet transfers it back to the deployer", "second", async () => ({
    receipt: await send(W, { address: nft, abi: nftAbi, functionName: "transferFrom", args: [wAddr, dAddr, ID()] }),
  }));

  // ================================================================ 4. a listing, then cancel it
  if (!state.ctx.l2) {
    const l = await newListing(dAddr, "fixed", parseUnits("150", 18), 2n);
    state.ctx.l2 = ser(l);
    state.ctx.l2sig = await sign(D, l);
    state.ctx.epochAtList = String(l.epoch);
    save();
  }
  const l2 = de(state.ctx.l2);
  await step("announce-2", "Announce a second listing (150 MUSD)", "deployer", async () => ({
    receipt: await send(D, { address: market, abi: marketAbi, functionName: "announce", args: [l2, state.ctx.l2sig] }),
  }));
  {
    const c = (await bounds()).minColl;
    await refuse("bounds-violation", "a buyer who requires more collateral than the position has", W, market, marketAbi, "buy", [l2, state.ctx.l2sig, await bounds({ minColl: c + 1n }), wAddr, noPermit]);
  }
  await step("cancel", "The seller cancels the listing on chain", "deployer", async () => ({
    receipt: await send(D, { address: market, abi: marketAbi, functionName: "cancel", args: [l2] }),
  }));
  await refuse("cancelled", "buying the cancelled listing", W, market, marketAbi, "buy", [l2, state.ctx.l2sig, await bounds(), wAddr, noPermit]);

  // an expired listing: signed with a 45 second deadline, then we let the chain pass it
  if (!state.ctx.l3) {
    const l = await newListing(dAddr, "short", parseUnits("100", 18), 3n);
    state.ctx.l3 = ser(l);
    state.ctx.l3sig = await sign(D, l);
    save();
  }
  {
    const l3 = de(state.ctx.l3);
    while ((await block()).timestamp <= l3.deadline) await sleep(5000);
    await refuse("expired", "buying a listing after its deadline", W, market, marketAbi, "buy", [l3, state.ctx.l3sig, await bounds({ expectedEpoch: l3.epoch }), wAddr, noPermit]);
  }

  // ================================================================ 5. Dutch auction buy
  if (!state.ctx.l4) {
    const l = await newListing(dAddr, "dutch", parseUnits("120", 18), 4n, parseUnits("60", 18));
    state.ctx.l4 = ser(l);
    state.ctx.l4sig = await sign(D, l);
    state.ctx.epochAtList = String(l.epoch);
    save();
  }
  const l4 = de(state.ctx.l4);
  await step("announce-dutch", "Announce a Dutch auction: 120 MUSD falling to 60 over 15 minutes", "deployer", async () => ({
    receipt: await send(D, { address: market, abi: marketAbi, functionName: "announce", args: [l4, state.ctx.l4sig] }),
    data: { listing: JSON.parse(ser(l4)) },
  }));
  await step("approve-musd-dutch", "The second wallet approves the market for MUSD", "second", async () => ({
    receipt: await send(W, { address: musd, abi: erc20, functionName: "approve", args: [market, parseUnits("200", 18)] }),
  }));
  await step("buy-dutch", "The second wallet buys at the auction's current price", "second", async () => {
    await sleep(25_000); // let the price fall a little
    const receipt = await send(W, { address: market, abi: marketAbi, functionName: "buy", args: [l4, state.ctx.l4sig, await bounds({ maxPrice: parseUnits("200", 18) }), wAddr, noPermit] });
    const s = sold(receipt);
    if (!s) throw new Error("no Sold event");
    if (!(s.price < l4.startPrice && s.price > l4.endPrice)) throw new Error(`price ${s.price} is not strictly inside the auction range`);
    const buyBlock = await pub.getBlock({ blockNumber: receipt.blockNumber });
    return { receipt, note: `sold at ${fmt(s.price, 4)} MUSD, between the 120 start and the 60 floor; fee ${fmt(s.fee, 4)}`, data: { price: String(s.price), fee: String(s.fee), elapsedSeconds: String(buyBlock.timestamp - l4.startTime) } };
  });
  await step("transfer-back-3", "The second wallet transfers it back to the deployer", "second", async () => ({
    receipt: await send(W, { address: nft, abi: nftAbi, functionName: "transferFrom", args: [wAddr, dAddr, ID()] }),
  }));

  // ================================================================ 6. guardian: ratio floor, keeper acts
  await step("fund-reserve", "Fund the guardian reserve with BTC", "deployer", async () => ({
    receipt: await send(D, { address: vault, abi: vaultAbi, functionName: "fundReserveBtc", args: [], value: reserveBtc }),
    note: `${fmt(reserveBtc, 4)} BTC, withdrawable by the holder at any time`,
  }));
  await step("policy-floor", "Set the policy floor just above the current ratio", "deployer", async () => {
    const info = await lensInfo();
    state.ctx.icrBeforeFloor = String(info.icr);
    const p = defaultPolicy({ floorIcr: info.icr + parseUnits("0.04", 18), targetIcr: info.icr + parseUnits("0.10", 18) });
    const receipt = await send(D, { address: vault, abi: vaultAbi, functionName: "setPolicy", args: [p] });
    return { receipt, note: `ratio ${(Number(info.icr) / 1e16).toFixed(2)}%, floor ${(Number(p.floorIcr) / 1e16).toFixed(2)}%, target ${(Number(p.targetIcr) / 1e16).toFixed(2)}%. The oracle cannot be moved on testnet, so the floor is raised instead` };
  });
  if (!stepOf("keeper-topup")) {
    const plan = await read<{ kind: number; reason: number; amount: bigint; tip: bigint }>(vault, vaultAbi, "preview");
    state.notes.push(`preview before the keeper: ${KIND_NAMES[Number(plan.kind)]} amount ${plan.amount} tip ${plan.tip}`);
    if (Number(plan.kind) !== 1) throw new Error(`the planner does not say TopUpBtc (kind ${plan.kind}, reason ${REASON_NAMES[Number(plan.reason)]})`);
  }
  await step("keeper-topup", "The keeper tops the position up (ratio floor)", "keeper", async () => {
    const before = await lensInfo();
    const kBefore = await btcOf(kAddr);
    const outcomes = await runOnce(realChain(cfg, K.publicClient, K.walletClient), { fromBlock: BigInt(cfg.deployedAtBlock), dryRun: false, log: (l) => console.log("    keeper:", l) });
    const mine = outcomes.find((o) => o.vault.toLowerCase() === vault.toLowerCase());
    if (!mine || mine.result !== "sent") throw new Error(`keeper did not send: ${json(outcomes)}`);
    const after = await lensInfo();
    const kAfter = await btcOf(kAddr);
    const receipt = await pub.getTransactionReceipt({ hash: mine.tx });
    if (after.coll <= before.coll) throw new Error("collateral did not increase");
    return {
      receipt,
      note: `collateral ${fmt(before.coll, 5)} -> ${fmt(after.coll, 5)} BTC, ratio ${(Number(before.icr) / 1e16).toFixed(2)}% -> ${(Number(after.icr) / 1e16).toFixed(2)}%; keeper tip ${mine.tip} wei (keeper balance moved ${kAfter - kBefore} wei net of its gas)`,
      data: { collBefore: String(before.coll), collAfter: String(after.coll), icrBefore: String(before.icr), icrAfter: String(after.icr), amount: String(mine.amount), tip: String(mine.tip) },
    };
  });
  await refuse("keeper-outside-policy", "a keeper calls execute while the position is inside its policy", K, vault, vaultAbi, "execute", [ZERO, ZERO]);

  // ================================================================ 7. guardian: redemption defense
  await step("policy-defense", "Set a redemption-defense floor far above the real buffer", "deployer", async () => {
    const info = await lensInfo();
    const p = defaultPolicy({ floorIcr: parseUnits("1.15", 18), targetIcr: info.icr + parseUnits("0.10", 18), bufferFloorMusd: parseUnits("10000000", 18), maxWalkSteps: 100 });
    const receipt = await send(D, { address: vault, abi: vaultAbi, functionName: "setPolicy", args: [p] });
    const buf = await read<{ buffer: bigint; eligibleAhead: bigint; steps: bigint; complete: boolean }>(lens, lensAbi, "redemptionBuffer", [ID(), 100n]);
    state.ctx.defenseComplete = String(buf.complete);
    return { receipt, note: `real buffer ahead of the position: ${fmt(buf.buffer, 2)} MUSD across ${buf.eligibleAhead} troves, walk ${buf.complete ? "complete" : "NOT complete"} in ${buf.steps} steps; defense floor 10,000,000 MUSD`, data: { buffer: String(buf.buffer), eligibleAhead: String(buf.eligibleAhead), steps: String(buf.steps), complete: buf.complete } };
  });
  if (!stepOf("keeper-defense")) {
    let plan = await read<{ kind: number; reason: number; amount: bigint }>(vault, vaultAbi, "preview");
    // At 135% the position sits more than 100 troves from the front of the redemption queue, so the
    // walk cannot finish and Unknown never acts. Lowering the ratio moves it forward: the holder
    // takes back some of their own collateral (no new BTC is spent), and the defense is tried again.
    if (Number(plan.kind) !== 3 && Number(plan.reason) === 6 && !stepOf("withdraw-for-defense")) {
      await step("withdraw-for-defense", "Lower the ratio to about 118% so the position sits nearer the front of the queue", "deployer", async () => {
        const info = await lensInfo();
        const wantColl = (info.debt * parseUnits("1.18", 18) + info.price - 1n) / info.price;
        const amount = info.coll - wantColl;
        const receipt = await send(D, { address: vault, abi: vaultAbi, functionName: "withdrawCollateral", args: [amount, ZERO, ZERO] });
        const after = await lensInfo();
        return { receipt, note: `withdrew ${fmt(amount, 5)} BTC of the holder's own collateral, ratio ${(Number(info.icr) / 1e16).toFixed(2)}% -> ${(Number(after.icr) / 1e16).toFixed(2)}%`, data: { amount: String(amount) } };
      });
      await step("policy-defense-2", "Set the redemption-defense policy again at the lower ratio", "deployer", async () => {
        const info = await lensInfo();
        const p2 = defaultPolicy({ floorIcr: parseUnits("1.12", 18), targetIcr: info.icr + parseUnits("0.10", 18), bufferFloorMusd: parseUnits("10000000", 18), maxWalkSteps: 100 });
        const receipt = await send(D, { address: vault, abi: vaultAbi, functionName: "setPolicy", args: [p2] });
        const buf = await read<{ buffer: bigint; eligibleAhead: bigint; steps: bigint; complete: boolean }>(lens, lensAbi, "redemptionBuffer", [ID(), 100n]);
        return { receipt, note: `real buffer ahead now: ${fmt(buf.buffer, 2)} MUSD across ${buf.eligibleAhead} troves, walk ${buf.complete ? "complete" : "NOT complete"} in ${buf.steps} steps`, data: { buffer: String(buf.buffer), eligibleAhead: String(buf.eligibleAhead), steps: String(buf.steps), complete: buf.complete } };
      });
      plan = await read<{ kind: number; reason: number; amount: bigint }>(vault, vaultAbi, "preview");
    }
    if (Number(plan.kind) === 3) {
      await step("keeper-defense", "The keeper tops the position up (redemption defense)", "keeper", async () => {
        const before = await lensInfo();
        const outcomes = await runOnce(realChain(cfg, K.publicClient, K.walletClient), { fromBlock: BigInt(cfg.deployedAtBlock), dryRun: false });
        const mine = outcomes.find((o) => o.vault.toLowerCase() === vault.toLowerCase());
        if (!mine || mine.result !== "sent") throw new Error(`keeper did not send: ${json(outcomes)}`);
        const after = await lensInfo();
        const receipt = await pub.getTransactionReceipt({ hash: mine.tx });
        return { receipt, note: `DefendBtc: collateral ${fmt(before.coll, 5)} -> ${fmt(after.coll, 5)} BTC after a complete walk proved the buffer was under the floor`, data: { amount: String(mine.amount), collBefore: String(before.coll), collAfter: String(after.coll) } };
      });
    } else {
      const n = `redemption defense NOT demonstrated: the planner said ${KIND_NAMES[Number(plan.kind)]} / ${REASON_NAMES[Number(plan.reason)]}. A walk that cannot finish within 100 steps is Unknown, and Unknown never acts.`;
      if (!state.notes.includes(n)) state.notes.push(n);
      console.log("  " + n);
    }
  }

  // a reserve bound against a live listing (the seller could empty the reserve after signing)
  if (!state.ctx.l5) {
    const l = await newListing(dAddr, "fixed", parseUnits("100", 18), 5n);
    state.ctx.l5 = ser(l);
    state.ctx.l5sig = await sign(D, l);
    state.ctx.epochAtList = String(l.epoch);
    save();
  }
  {
    const l5 = de(state.ctx.l5);
    const reserve = await read<bigint>(vault, vaultAbi, "reserveBtc");
    await refuse("reserve-bound", "a buyer who requires more BTC reserve than the vault holds", W, market, marketAbi, "buy", [l5, state.ctx.l5sig, await bounds({ minReserveBtc: reserve + 1n }), wAddr, noPermit]);
  }

  // ================================================================ done
  state.balances.after = await snapshot();
  state.finishedAt = new Date().toISOString();
  const final = await lensInfo();
  state.ctx.finalHolder = final.holder;
  state.ctx.finalIcr = String(final.icr);
  save();
  writeFileSync(PROOF_MD, renderMarkdown(state, cfg, final));
  console.log(`done. ${state.steps.length} steps, ${state.refusals.length} refusals. Wrote docs/PROOF.md and docs/proof.json`);
}

function renderMarkdown(s: State, cfg: ReturnType<typeof loadConfig>, final: Record<string, any>): string {
  const tx = (h?: string) => (h ? `[\`${h.slice(0, 10)}…${h.slice(-6)}\`](${s.explorer}/tx/${h})` : "");
  const addr = (a: string) => `[\`${a}\`](${s.explorer}/address/${a})`;
  const b0 = s.balances.before ?? {};
  const b1 = s.balances.after ?? {};
  const rows = s.steps.map((x) => `| ${x.n} | ${x.title} | ${x.actor ?? ""} | ${tx(x.tx)} | ${x.block ?? ""} | ${x.note ?? ""} |`).join("\n");
  const ref = s.refusals.map((r) => `| ${r.what} | \`${r.call}\` on ${addr(r.contract)} | \`${r.revert}\` |`).join("\n");
  return `# Live proof, Mezo testnet

Generated by \`npm run proof\` in [\`keeper/\`](../keeper) on ${s.startedAt.slice(0, 10)}. Every row is a real transaction on chain ${s.chainId} against the Wave 2 contracts in [DEPLOYMENTS.md](DEPLOYMENTS.md). The machine-readable version is [\`proof.json\`](proof.json).

| Wallet | Address |
|---|---|
| Deployer (holder, seller, fee recipient) | ${addr(s.wallets.deployer)} |
| Second wallet (buyer) | ${addr(s.wallets.second)} |
| Keeper | ${addr(s.wallets.keeper)} |

Position: NFT id ${s.ctx.id}, vault ${addr(s.ctx.vault)}. Market ${addr(cfg.trozu.market)}, factory ${addr(cfg.trozu.factory)}.

## Transactions

| # | Step | Sent by | Tx | Block | Result |
|---|---|---|---|---|---|
${rows}

## Refusals

Each of these is an \`eth_call\` against the live contract, not a transaction: it costs nothing, changes nothing, and the revert is the contract's own.

| What was tried | Call | Real revert |
|---|---|---|
${ref}

## Notes and limits

- The oracle cannot be moved on testnet. The guardian steps set the policy floor above the position's current ratio, so the keeper acts because the contract's own planner (\`preview\`) says to. That is a legitimate trigger, but it is not a price crash.
- The seller is also the fee recipient on this deployment (the deployer), so the fee is shown through the MUSD \`Transfer\` logs and the \`Sold\` event rather than as a change in someone else's balance.
- The keeper in step "tops the position up" is the same code that runs on the GitHub schedule ([\`keeper/src/keeper.ts\`](../keeper/src/keeper.ts)); it was pointed at this vault and sent the transaction.
${s.notes.map((n) => `- ${n}`).join("\n")}

## Balances

| | Before | After |
|---|---|---|
| Deployer BTC | ${fmt(BigInt(b0.deployerBtc ?? "0"))} | ${fmt(BigInt(b1.deployerBtc ?? "0"))} |
| Second wallet BTC | ${fmt(BigInt(b0.secondBtc ?? "0"))} | ${fmt(BigInt(b1.secondBtc ?? "0"))} |
| Keeper BTC | ${fmt(BigInt(b0.keeperBtc ?? "0"))} | ${fmt(BigInt(b1.keeperBtc ?? "0"))} |
| Deployer MUSD | ${fmt(BigInt(b0.deployerMusd ?? "0"), 2)} | ${fmt(BigInt(b1.deployerMusd ?? "0"), 2)} |
| Second wallet MUSD | ${fmt(BigInt(b0.secondMusd ?? "0"), 2)} | ${fmt(BigInt(b1.secondMusd ?? "0"), 2)} |

Final state: the deployer holds position ${s.ctx.id}, ratio ${(Number(final.icr) / 1e16).toFixed(2)}%, with a live guardian policy and a BTC reserve. This is the staged "guarded position".
`;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
