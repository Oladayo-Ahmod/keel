import { WAD } from "./format";

const BPS = 10_000n;
const CENT = 10n ** 16n;

/** Everything the estimate is built from. All money is 1e18 fixed point, rates are basis points. */
export interface FairPriceInput {
  active: boolean;
  priceOk: boolean;
  /** Collateral value minus debt, from the lens. Can be negative for an underwater position. */
  equity: bigint;
  principal: bigint;
  lockedRateBps: number;
  globalRateBps: number;
  /** BTC and MUSD parked in the guardian reserve. It stays in the vault, so it goes with the NFT. */
  reserveBtc?: bigint;
  reserveMusd?: bigint;
  btcPrice?: bigint;
  /** How many years of the rate advantage the asking price carries. */
  years?: number;
}

export interface FairPrice {
  available: boolean;
  /** Why there is no suggestion, in a sentence. */
  reason?: string;
  equity: bigint;
  reserveValue: bigint;
  /** What the buyer gets that is worth money today, with no rate premium: equity plus reserve, never below zero. */
  baseValue: bigint;
  /** Global rate minus locked rate, in basis points. Positive means the locked rate is the cheaper one. */
  spreadBps: number;
  /** Interest the locked rate saves in a year at today's market rate. Zero when there is no advantage. */
  yearlyValue: bigint;
  years: number;
  premium: bigint;
  hasPremium: boolean;
  /** Fixed-price suggestion, rounded down to a cent. */
  suggested: bigint;
  /** A falling price from the suggestion down to the base value. Only when there is a premium to fall through. */
  dutch?: { start: bigint; end: bigint };
  note: string;
}

const floorCent = (x: bigint) => x - (x % CENT);

/**
 * A starting point for the asking price, not a valuation. The buyer takes the collateral and the debt, so the
 * floor is equity (plus any guardian reserve). On top of that sits what the locked rate saves them over `years`
 * at today's market rate. A spread of zero or less adds nothing: a rate at or above the market is not a feature,
 * and this does not subtract for it either, since a buyer could refinance.
 */
export function fairPrice(i: FairPriceInput): FairPrice {
  const years = i.years ?? 1;
  const spreadBps = i.globalRateBps - i.lockedRateBps;
  const reserveValue =
    ((i.reserveBtc ?? 0n) * (i.btcPrice ?? 0n)) / WAD + (i.reserveMusd ?? 0n);
  const empty = (reason: string): FairPrice => ({
    available: false, reason, equity: i.equity, reserveValue, baseValue: 0n, spreadBps,
    yearlyValue: 0n, years, premium: 0n, hasPremium: false, suggested: 0n, note: reason,
  });

  if (!i.active) return empty("There is no open trove, so there is nothing to price.");
  if (!i.priceOk) return empty("The price feed is not answering, so equity is unknown and no price is suggested.");

  const baseRaw = i.equity + reserveValue;
  const baseValue = baseRaw > 0n ? baseRaw : 0n;
  const yearlyValue = spreadBps > 0 ? (i.principal * BigInt(spreadBps)) / BPS : 0n;
  // the horizon in hundredths of a year keeps the arithmetic in integers
  const premium = (yearlyValue * BigInt(Math.round(years * 100))) / 100n;
  const hasPremium = premium > 0n;
  const suggested = floorCent(baseValue + premium);

  if (suggested === 0n) {
    return { ...empty("Equity is zero or negative and there is no rate advantage, so there is nothing to ask for."), equity: i.equity };
  }

  const note = hasPremium
    ? "Equity plus what the locked rate saves a buyer over the horizon, at today's market rate. If rates move, so does this."
    : spreadBps < 0
      ? "Your locked rate is above the market rate, so there is no premium to ask for. A buyer could refinance, so the price is equity only."
      : "Your locked rate equals the market rate, so there is no premium to ask for. The price is equity only.";

  const dutch = hasPremium && floorCent(baseValue) > 0n && floorCent(baseValue) < suggested ? { start: suggested, end: floorCent(baseValue) } : undefined;
  return {
    available: true, equity: i.equity, reserveValue, baseValue, spreadBps, yearlyValue, years,
    premium, hasPremium, suggested, dutch, note,
  };
}
