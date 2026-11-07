/**
 * Explicit gas limits for every transaction the SDK builds.
 *
 * Mezo's public node cannot be trusted to estimate gas: it answered eth_estimateGas with about
 * 21,300 for a call that needs about 5.6M, and once with a limit under the data-gas floor, so the
 * transaction ran out of gas or was refused (docs/PROOF.md). A wallet that estimates for itself
 * inherits that, so every builder sets the limit and callers should send it as it is.
 *
 * Mezo charges at least half of the limit, so a generous limit is cheap but not free: 6M costs about
 * 3M gas. The block limit is 10M, so nothing goes above CAP.
 *
 * The table below is copied from web/src/lib/gas.ts, which the web app sends, and checked against the
 * wallet round trip in docs/roundtrip.json. test/webgas.test.ts fails if the two ever differ. Each
 * limit says what backs it:
 *
 *   measured    gasUsed read from a receipt in docs/proof.json, limit = the larger of that plus 30%
 *               and the floor. (A receipt can never show less than half the limit that was sent, so a
 *               measured 3,000,000 is an upper bound read off a 6M limit, not an exact figure.)
 *   measured    (also) the least gas an eth_call needs at one pinned block, bisected by scripts/measure-gas.ts and
 *               recorded in docs/gas-measurements.json, with limit = twice that rounded up to 5,000. An eth_call has no
 *               half-limit charge, so this is the true minimum; calibrated against receipts it agrees within about 1%.
 *               `gasUsed` holds the minimum. For the calls that re-sort the trove and take optional hints, `unhinted` is
 *               the limit when the caller gives none (about 3.5M measured against about 0.44M with hints).
 *   roundtrip   no usable measurement, but this exact limit was sent through the app on matsnet in the
 *               wallet round trip and the transaction succeeded. Every gasUsed in that file is exactly
 *               half its limit (the half-limit charge), so it proves the limit is enough, not what the
 *               call really uses.
 *   unmeasured  never run on chain. Only the floor applies, because there is nothing to add 30% to.
 *               docs/INTEGRATIONS.md lists these.
 */

export const CAP = 9_500_000;
/** Above the data-gas floor with room to spare, for calls that never touch Mezo's sorted list. */
export const FLOOR_SIMPLE = 1_000_000;
/** Any call that re-inserts the trove in the sorted list. About 0.6M with a good hint and 4.5M to 7.4M with none, measured. */
export const FLOOR_SORTED = 6_000_000;

export type GasBasis = "measured" | "roundtrip" | "unmeasured";

export interface GasEntry {
  /** The limit the builder sends. */
  limit: number;
  basis: GasBasis;
  /** Re-sorts the trove in Mezo's list, so it also gets CAP when a redemption-defense walk is on. */
  sorted: boolean;
  /** The receipt gasUsed behind a `measured` limit. */
  gasUsed?: number;
  /** The limit when the caller gives no sorted-list hints, for the calls where that costs far more. */
  unhinted?: number;
  /** Where the evidence is. */
  source: string;
}

const proof = "docs/proof.json";
const trip = "docs/roundtrip.json";
const none = "never run on chain";

const e = (limit: number, basis: GasBasis, sorted: boolean, source: string, gasUsed?: number, unhinted?: number): GasEntry => ({ limit, basis, sorted, source, gasUsed, unhinted });
const bis = "docs/gas-measurements.json";

/**
 * Keyed by function name. Wave 1 and Wave 2 vaults share these names, so one entry covers both.
 * Limits are literals on purpose: they are what gets sent, and the test compares them with the web app's.
 */
export const GAS_TABLE: Record<string, GasEntry> = {
  // position, through the vault
  openPosition: e(6_000_000, "measured", true, proof, 912_587),
  addCollateral: e(6_000_000, "roundtrip", true, trip),
  withdrawCollateral: e(6_000_000, "roundtrip", true, trip),
  borrow: e(6_000_000, "roundtrip", true, trip),
  repay: e(880000, "measured", true, bis, 437989, CAP),
  repayWithPermit: e(6_000_000, "roundtrip", true, trip),
  refinance: e(880000, "measured", true, bis, 439580, CAP),
  close: e(895000, "measured", true, bis, 446378),
  closeWithPermit: e(975000, "measured", true, bis, 486154),
  claimSurplus: e(325000, "measured", false, bis, 160864),
  sweep: e(1_000_000, "roundtrip", false, trip),
  // reserve and guardian policy
  fundReserveBtc: e(1_000_000, "measured", false, proof, 58_000),
  fundReserveMusd: e(200000, "measured", false, bis, 97801),
  fundReserveMusdWithPermit: e(1_000_000, "roundtrip", false, trip),
  withdrawReserveBtc: e(1_000_000, "roundtrip", false, trip),
  withdrawReserveMusd: e(1_000_000, "roundtrip", false, trip),
  setPolicy: e(3_900_000, "measured", false, proof, 3_000_000),
  clearPolicy: e(180000, "measured", false, bis, 88544),
  // the guardian's own call: 5,219,911 measured for a ratio-floor top-up with no hints. Not in the web table, which has no keeper.
  execute: e(6_785_885, "measured", true, proof, 5_219_911),
  // market
  announce: e(1_000_000, "measured", false, proof, 99_293),
  cancel: e(1_000_000, "measured", false, proof, 49_507),
  cancelAll: e(95000, "measured", false, bis, 45008),
  buy: e(1_500_000, "measured", false, proof, 276_848),
  // tokens and the NFT
  approve: e(1_000_000, "measured", false, proof, 46_242),
  setApprovalForAll: e(55000, "measured", false, bis, 26785),
  safeTransferFrom: e(1_000_000, "measured", false, proof, 86_373),
  transferFrom: e(1_000_000, "measured", false, proof, 86_373),
  transfer: e(1_000_000, "measured", false, proof, 51_697),
};

/** Actions in this table that the web app has no entry for, and why. The web test allows exactly these. */
export const SDK_ONLY = ["execute"] as const;

export interface GasOptions {
  /**
   * Whether the call carries sorted-list hints. Left out means yes. Set false for a call without them: Mezo then
   * walks the list from its head, which is several times the gas, so the entry's `unhinted` limit is used.
   */
  hinted?: boolean;
  /**
   * The position has a redemption-defense policy set. The defense adds a buffer walk of up to 100 troves:
   * the keeper's first defense `execute` ran out at 6M and needs about 7.3M (docs/PROOF.md), and a
   * collateral withdrawal in the same proof run used 7,451,858 (step 20, which I have not separated into
   * walk and non-walk cost). Both fit under CAP but not under the 6M floor, so this sets the limit to CAP.
   */
  defenseWalk?: boolean;
}

/** The gas limit for a write. Throws for a function with no entry, so a new write cannot go out without one. */
export function gasLimitFor(functionName: string, opts: GasOptions = {}): number {
  const g = GAS_TABLE[functionName];
  if (!g) throw new Error(`no gas limit defined for ${functionName}; add it to GAS_TABLE in gas.ts`);
  if (opts.defenseWalk && g.sorted) return CAP;
  if (opts.hinted === false && g.unhinted !== undefined) return Math.min(CAP, g.unhinted);
  return Math.min(CAP, g.limit);
}

/** Function names whose limit has no measurement behind it, for the docs. */
export const unmeasured = (): string[] => Object.entries(GAS_TABLE).filter(([, g]) => g.basis === "unmeasured").map(([n]) => n);
