/**
 * Explicit gas limits for every write the app sends.
 *
 * Mezo's public node cannot be trusted to estimate gas: it answered eth_estimateGas with about
 * 21,300 for a call that needs about 5.6M, and once with a limit under the data-gas floor, so the
 * transaction ran out of gas or was refused (docs/DEPLOYMENTS.md, docs/DECISIONS.md). A wallet
 * that estimates for itself inherits that, so the app always sets the limit.
 *
 * Gas price on matsnet is a few hundred wei, and Mezo charges at least half of the limit (checked
 * 2026-11-07: a plain self-send with a 1M limit was charged 500,000 gas), so a generous limit is
 * cheap but not free: 6M costs about 3M gas, under 0.000000001 BTC. Rule per action: the larger of the measured gas with 30%
 * headroom and a floor, never above CAP (the chain's block limit is 10M).
 *
 * `measured` is one of two things, and the `source` says which:
 *  - gasUsed from docs/proof.json (the live proof on matsnet). Because of the half-limit charge, a receipt can never
 *    show less than half the limit that was sent: where a number below is 3,000,000 it is an upper bound read off a
 *    6M limit, not an exact figure.
 *  - the least gas an eth_call needs to succeed at one pinned block, bisected by packages/sdk/scripts/measure-gas.ts
 *    and recorded in docs/gas-measurements.json. An eth_call has no half-limit charge, so this is the true minimum
 *    (calibrated against receipts it agrees within about 1%). These get twice that, rounded up to 5,000.
 * `null` means not measured, so only the floor applies.
 *
 * A call that re-inserts the trove in Mezo's sorted list costs about 0.44M with the hints the app computes right
 * before sending and about 3.5M without them (both measured), so those rules carry `unhinted`: the limit to use
 * when a caller has no hints. The app always has hints for them.
 */

export const CAP = 9_500_000;
/** Above the data-gas floor with room to spare, for calls that never touch the sorted list. */
export const FLOOR_SIMPLE = 1_000_000;
/** Any call that re-inserts the trove in Mezo's sorted list. About 0.6M with a good hint and about 4.5M to 7.4M with none, measured. */
export const FLOOR_SORTED = 6_000_000;
const HEADROOM_PCT = 130;
/** Headroom on a bisected minimum: the limit is about twice what the call really needs. */
const BISECTED_HEADROOM_PCT = 200;
const BISECTED_STEP = 5_000;

export interface GasRule {
  measured: number | null;
  floor: number;
  /** Where the measured number comes from. */
  source: string;
  /** Percent of `measured` to allow. 130 unless the number is a bisected minimum. */
  headroomPct?: number;
  /** Round the padded limit up to a multiple of this. */
  step?: number;
  /** The limit when the caller has no sorted-list hints. */
  unhinted?: number;
}

const proof = "docs/proof.json";
const bisected = "docs/gas-measurements.json (bisected eth_call)";
const simple = (measured: number | null, source = proof): GasRule => ({ measured, floor: FLOOR_SIMPLE, source });
const sorted = (measured: number | null, source = proof): GasRule => ({ measured, floor: FLOOR_SORTED, source });
/** A true minimum from the bisection. With no floor, since the number is not an estimate; `unhinted` is for calls that take optional hints. */
const minimum = (measured: number, unhinted?: number): GasRule => ({ measured, floor: 0, source: bisected, headroomPct: BISECTED_HEADROOM_PCT, step: BISECTED_STEP, unhinted });

/** Keyed by function name. Wave 1 and Wave 2 vaults share these names, so one rule covers both. */
export const GAS_RULES: Record<string, GasRule> = {
  // position, through the vault
  openPosition: sorted(912_587),
  addCollateral: sorted(null),
  withdrawCollateral: sorted(null),
  borrow: sorted(null),
  repay: minimum(437989, CAP),
  repayWithPermit: sorted(null),
  refinance: minimum(439580, CAP),
  close: minimum(446378),
  closeWithPermit: minimum(486154),
  claimSurplus: minimum(160864),
  sweep: simple(null),
  // reserve and guardian policy
  fundReserveBtc: simple(58_000),
  fundReserveMusd: minimum(97801),
  fundReserveMusdWithPermit: simple(null),
  withdrawReserveBtc: simple(null),
  withdrawReserveMusd: simple(null),
  // a policy with a redemption-defense walk checks the queue while it is set: 3,000,000 measured
  setPolicy: { measured: 3_000_000, floor: FLOOR_SIMPLE, source: proof },
  clearPolicy: minimum(88544),
  // market
  announce: simple(99_293),
  cancel: simple(49_507),
  cancelAll: minimum(45008),
  buy: { measured: 276_848, floor: 1_500_000, source: proof },
  // tokens and the NFT
  approve: simple(46_242),
  setApprovalForAll: minimum(26785),
  safeTransferFrom: simple(86_373),
  transferFrom: simple(86_373),
  transfer: simple(51_697),
};

/**
 * The gas limit for a write, as a number. Throws for a function with no rule, so a new write cannot go out without one.
 * `hinted: false` is for a caller that has no sorted-list hints and so pays for a walk from the head of Mezo's list.
 */
export function gasLimitFor(functionName: string, opts: { hinted?: boolean } = {}): number {
  const rule = GAS_RULES[functionName];
  if (!rule) throw new Error(`no gas limit defined for ${functionName}; add it to GAS_RULES in lib/gas.ts`);
  if (opts.hinted === false && rule.unhinted !== undefined) return Math.min(CAP, rule.unhinted);
  const pct = rule.headroomPct ?? HEADROOM_PCT;
  let padded = rule.measured === null ? 0 : Math.ceil((rule.measured * pct) / 100);
  if (rule.step) padded = Math.ceil(padded / rule.step) * rule.step;
  return Math.min(CAP, Math.max(padded, rule.floor));
}

/** Write parameters with the gas limit filled in. Every transaction the app sends goes through this. */
export function withGas<T extends { functionName: string; gas?: bigint }>(params: T): T & { gas: bigint } {
  return { ...params, gas: BigInt(gasLimitFor(params.functionName)) };
}

/** "6,000,000" for the review step. */
export function formatGas(limit: number | bigint): string {
  return Number(limit).toLocaleString("en-US");
}
