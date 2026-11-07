import { TrozuValidationError } from "./errors.js";
import type { Bounds, Listing, PolicyInput, PositionView, RiskLevel } from "./types.js";

export const WAD = 10n ** 18n;
export const MAX_UINT256 = 2n ** 256n - 1n;

/** Where Mezo liquidates. */
export const MCR = 11n * 10n ** 17n;
export const CAUTION = 125n * 10n ** 16n;
/** Also Mezo's Recovery Mode threshold. */
export const SAFE = 15n * 10n ** 17n;
/** The Lens reports max uint256 for a trove with no debt, so anything this large means "no debt". */
export const NO_DEBT_ICR = 2n ** 200n;

export function riskOf(p: Pick<PositionView, "active" | "icr">): RiskLevel {
  if (!p.active) return "none";
  if (p.icr >= SAFE) return "safe";
  if (p.icr >= CAUTION) return "caution";
  if (p.icr >= MCR) return "danger";
  return "liquidatable";
}

/** collateral * price / debt, the same as Mezo's ICR. Undefined with no debt or no price. */
export function icrOf(coll: bigint, debt: bigint, price: bigint): bigint | undefined {
  if (debt === 0n || price === 0n) return undefined;
  return (coll * price) / debt;
}

/** A 1e18 ratio as a plain number of percent, 160.5 for 1.605e18. Null for the no-debt sentinel. */
export function icrPercent(icr: bigint): number | null {
  if (icr >= NO_DEBT_ICR) return null;
  return Number((icr * 10_000n) / WAD) / 100;
}

export const isDutch = (l: Pick<Listing, "startPrice" | "endPrice">) => l.startPrice !== l.endPrice;

/**
 * Price at time `t`, the same integer maths as `TrozuMarket.priceAt`: a straight line from startPrice
 * down to endPrice, the drop rounded down so the price rounds up against the buyer. The contract
 * reverts on underflow when endPrice is above startPrice (and `check` calls that BadParams), so this
 * throws rather than invent a number.
 */
export function priceAt(l: Pick<Listing, "startPrice" | "endPrice" | "startTime" | "endTime">, t: bigint): bigint {
  if (l.startPrice === l.endPrice || t <= l.startTime) return l.startPrice;
  if (t >= l.endTime) return l.endPrice;
  if (l.endPrice > l.startPrice) throw new TrozuValidationError(["endPrice is above startPrice"]);
  const drop = ((l.startPrice - l.endPrice) * (t - l.startTime)) / (l.endTime - l.startTime);
  return l.startPrice - drop;
}

/** Fee on a price, rounded up, like `feeOn`. The seller receives the rest. */
export function feeOn(price: bigint, feeBps: number): bigint {
  return (price * BigInt(feeBps) + 9_999n) / 10_000n;
}

/** What a buyer sees a position to be at the moment they decide. */
export interface Seen {
  epoch: bigint;
  coll: bigint;
  debt: bigint;
  rateBps: number;
  reserveBtc: bigint;
  reserveMusd: bigint;
}

/**
 * The bounds a buyer signs up to: exactly what they saw, with a little headroom only where the number
 * moves by itself (interest raises debt every second until the sale lands). The price cap is the price
 * now, which a Dutch auction can only lower.
 */
export function defaultBounds(seen: Seen, priceNow: bigint): Bounds {
  return {
    expectedEpoch: seen.epoch,
    minColl: seen.coll,
    maxDebt: seen.debt + seen.debt / 200n + 1n, // 0.5%, many days of interest
    minRateBps: seen.rateBps,
    maxRateBps: seen.rateBps,
    maxPrice: priceNow,
    minReserveBtc: seen.reserveBtc,
    minReserveMusd: seen.reserveMusd,
  };
}

/** Limits baked into TrozuVault. */
export const POLICY_LIMITS = {
  mcr: MCR,
  maxTargetIcr: 5n * WAD,
  minPeriod: 3600,
  maxPeriod: 30 * 86400,
  maxKeeperTip: 10n ** 14n,
  maxWalkSteps: 100,
} as const;

/** The reasons `setPolicy` would revert with `BadPolicy`, in the order the contract checks them. Empty means it would pass. */
export function validatePolicy(p: PolicyInput, l = POLICY_LIMITS): string[] {
  const e: string[] = [];
  if (p.floorIcr <= l.mcr) e.push("floorIcr has to be above 110%, the line where Mezo liquidates");
  if (p.targetIcr <= p.floorIcr) e.push("targetIcr has to be above floorIcr");
  if (p.targetIcr > l.maxTargetIcr) e.push("targetIcr cannot be above 500%");
  if (p.period < l.minPeriod || p.period > l.maxPeriod) e.push("period has to be between 1 hour and 30 days");
  if (p.keeperTipBtc > l.maxKeeperTip) e.push("keeperTipBtc is above the maximum tip");
  if (p.maxActionBtc === 0n && p.maxActionMusd === 0n) e.push("allow at least one of maxActionBtc and maxActionMusd");
  if (p.maxActionBtc > p.periodCapBtc || p.maxActionMusd > p.periodCapMusd) e.push("a single action cannot be larger than its period cap");
  if (p.keeperTipBtc > 0n && p.keeperTipBtc >= p.periodCapBtc) e.push("keeperTipBtc has to be below periodCapBtc, because it counts against it");
  if (p.maxWalkSteps > l.maxWalkSteps) e.push("maxWalkSteps cannot be above 100");
  if (p.bufferFloorMusd > 0n && (p.maxWalkSteps === 0 || p.maxActionBtc === 0n)) {
    e.push("redemption defense needs maxWalkSteps above zero and maxActionBtc above zero");
  }
  return e;
}

/** Of a period's allowance, how much is left. Never negative. */
export function remaining(cap: bigint, spent: bigint): bigint {
  return cap > spent ? cap - spent : 0n;
}

/** Whether the spending window has rolled over, so spent amounts no longer count. */
export function windowFresh(periodStart: bigint, period: number, now: bigint): boolean {
  return now >= periodStart + BigInt(period);
}
