/**
 * Explicit gas limits for every transaction the SDK builds.
 *
 * Mezo's public node cannot be trusted to estimate gas: it answered eth_estimateGas with about
 * 21,300 for a call that needs about 5.6M, and once with a limit under the data-gas floor, so the
 * transaction ran out of gas or was refused (docs/PROOF.md). A wallet that estimates for itself
 * inherits that, so every builder sets the limit and callers should send it as it is.
 *
 * Mezo charges at least half of the limit, so a generous limit is cheap but not free: 6M costs about
 * 3M gas. Rule per action: the larger of the measured gas with 30% headroom and a floor, never above
 * CAP (the chain's block limit is 10M).
 *
 * `measured` is gasUsed from the live proof run on matsnet (docs/PROOF.md, docs/proof.json). Because of
 * the half-limit charge a receipt never shows less than half the limit that was sent, so a measured
 * 3,000,000 is an upper bound read off a 6M limit, not an exact figure. `null` means never measured,
 * and only the floor applies. The numbers are the same ones the web app uses (web/src/lib/gas.ts).
 */

export const CAP = 9_500_000;
/** Above the data-gas floor with room to spare, for calls that never touch Mezo's sorted list. */
export const FLOOR_SIMPLE = 1_000_000;
/** Any call that re-inserts the trove in the sorted list. About 0.6M with a good hint and 4.5M to 7.4M with none, measured. */
export const FLOOR_SORTED = 6_000_000;
const HEADROOM_PCT = 130;

export interface GasRule {
  measured: number | null;
  floor: number;
  source: string;
}

const proof = "docs/proof.json";
const simple = (measured: number | null): GasRule => ({ measured, floor: FLOOR_SIMPLE, source: proof });
const sorted = (measured: number | null): GasRule => ({ measured, floor: FLOOR_SORTED, source: proof });

/** Keyed by function name. Wave 1 and Wave 2 vaults share these names, so one rule covers both. */
export const GAS_RULES: Record<string, GasRule> = {
  // position, through the vault
  openPosition: sorted(912_587),
  addCollateral: sorted(null),
  withdrawCollateral: sorted(null),
  borrow: sorted(null),
  repay: sorted(null),
  repayWithPermit: sorted(null),
  refinance: sorted(null),
  close: sorted(null),
  closeWithPermit: sorted(null),
  claimSurplus: simple(null),
  sweep: simple(null),
  // reserve and guardian policy
  fundReserveBtc: simple(58_000),
  fundReserveMusd: simple(null),
  fundReserveMusdWithPermit: simple(null),
  withdrawReserveBtc: simple(null),
  withdrawReserveMusd: simple(null),
  setPolicy: { measured: 3_000_000, floor: FLOOR_SIMPLE, source: proof },
  clearPolicy: simple(null),
  // the guardian's own call: 5,219,911 measured for a ratio-floor top-up with no hints
  execute: { measured: 5_219_911, floor: FLOOR_SORTED, source: proof },
  // market
  announce: simple(99_293),
  cancel: simple(49_507),
  cancelAll: simple(null),
  buy: { measured: 276_848, floor: 1_500_000, source: proof },
  // tokens and the NFT
  approve: simple(46_242),
  setApprovalForAll: simple(null),
  safeTransferFrom: simple(86_373),
  transferFrom: simple(86_373),
  transfer: simple(51_697),
};

export interface GasOptions {
  /**
   * The position has a redemption-defense policy set. The defense adds a buffer walk of up to 100 troves:
   * the keeper's first defense `execute` ran out at 6M and needs about 7.3M (docs/PROOF.md), and a
   * collateral withdrawal in the same proof run used 7,451,858 (step 20, which I have not separated into
   * walk and non-walk cost). Both fit under CAP but not under the 6M floor, so this sets the limit to CAP.
   */
  defenseWalk?: boolean;
}

/** The gas limit for a write, as a number. Throws for a function with no rule, so a new write cannot go out without one. */
export function gasLimitFor(functionName: string, opts: GasOptions = {}): number {
  const rule = GAS_RULES[functionName];
  if (!rule) throw new Error(`no gas limit defined for ${functionName}; add it to GAS_RULES in gas.ts`);
  if (opts.defenseWalk && rule.floor >= FLOOR_SORTED) return CAP;
  const padded = rule.measured === null ? 0 : Math.ceil((rule.measured * HEADROOM_PCT) / 100);
  return Math.min(CAP, Math.max(padded, rule.floor));
}
