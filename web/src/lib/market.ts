import { formatMusd } from "./format";

type Address = `0x${string}`;

/** Mirrors `TrozuMarket.Listing`. Field order and types are part of the EIP-712 type hash. */
export interface Listing {
  seller: Address;
  tokenId: bigint;
  epoch: bigint;
  startPrice: bigint;
  endPrice: bigint;
  startTime: bigint;
  endTime: bigint;
  deadline: bigint;
  nonce: bigint;
  salt: bigint;
}

/** Mirrors `TrozuMarket.Bounds`, as of main 5b6b89f (the reserve minimums are the newest fields). */
export interface Bounds {
  expectedEpoch: bigint;
  minColl: bigint;
  maxDebt: bigint;
  minRateBps: number;
  maxRateBps: number;
  maxPrice: bigint;
  minReserveBtc: bigint;
  minReserveMusd: bigint;
}

export const LISTING_TYPES = {
  Listing: [
    { name: "seller", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "epoch", type: "uint256" },
    { name: "startPrice", type: "uint256" },
    { name: "endPrice", type: "uint256" },
    { name: "startTime", type: "uint64" },
    { name: "endTime", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "salt", type: "uint256" },
  ],
} as const;

export const MARKET_DOMAIN_NAME = "TrozuMarket";
export const MARKET_DOMAIN_VERSION = "1";

export function marketDomain(chainId: number, market: Address) {
  return { name: MARKET_DOMAIN_NAME, version: MARKET_DOMAIN_VERSION, chainId, verifyingContract: market } as const;
}

/** `TrozuMarket.State`, in declaration order. The index is what `check` and `ListingInvalid` return. */
export const STATES = [
  "Ok",
  "Filled",
  "Cancelled",
  "BadParams",
  "NotStarted",
  "Expired",
  "NonceRevoked",
  "BadSignature",
  "NotOwner",
  "NotApproved",
  "StaleEpoch",
  "TroveInactive",
  "NoCollateral",
] as const;
export type MarketState = (typeof STATES)[number];

const STATE_TEXT: Record<MarketState, string> = {
  Ok: "Open for sale.",
  Filled: "Already sold.",
  Cancelled: "The seller cancelled this listing.",
  BadParams: "The listing's prices or times are not valid.",
  NotStarted: "This sale has not started yet.",
  Expired: "This listing has expired.",
  NonceRevoked: "The seller cancelled all of their listings.",
  BadSignature: "The seller's signature does not match this listing.",
  NotOwner: "The seller no longer owns this position.",
  NotApproved: "The seller withdrew the market's approval to move this position.",
  StaleEpoch: "The position changed hands since this listing was signed.",
  TroveInactive: "The position has no open trove any more.",
  NoCollateral: "The position holds no collateral.",
};

export const stateName = (i: number | bigint): MarketState => STATES[Number(i)] ?? "BadParams";
export const stateText = (s: MarketState) => STATE_TEXT[s];

/**
 * Price at time `t`, the same integer maths as `TrozuMarket.priceAt`: a straight line from
 * startPrice down to endPrice, the drop rounded down so the price rounds up against the buyer.
 */
export function priceAt(l: Pick<Listing, "startPrice" | "endPrice" | "startTime" | "endTime">, t: bigint): bigint {
  if (l.startPrice === l.endPrice || t <= l.startTime) return l.startPrice;
  if (t >= l.endTime) return l.endPrice;
  const drop = ((l.startPrice - l.endPrice) * (t - l.startTime)) / (l.endTime - l.startTime);
  return l.startPrice - drop;
}

/** Fee on a price, rounded up, like `feeOn`. The seller receives the rest. */
export function feeOn(price: bigint, feeBps: number): bigint {
  const BPS = 10_000n;
  return (price * BigInt(feeBps) + BPS - 1n) / BPS;
}

export const isDutch = (l: Pick<Listing, "startPrice" | "endPrice">) => l.startPrice !== l.endPrice;

export interface CurvePoint {
  t: number;
  price: bigint;
}

/** Evenly spaced points from the listing's start to its deadline, for the Dutch chart. */
export function priceCurve(l: Listing, samples = 48): CurvePoint[] {
  const start = l.startTime;
  const end = l.deadline;
  const span = end - start;
  const out: CurvePoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = start + (span * BigInt(i)) / BigInt(samples);
    out.push({ t: Number(t), price: priceAt(l, t) });
  }
  return out;
}

export interface ListingForm {
  seller: Address;
  tokenId: bigint;
  epoch: bigint;
  nonce: bigint;
  salt: bigint;
  now: bigint;
  kind: "fixed" | "dutch";
  startPrice: bigint | undefined;
  endPrice: bigint | undefined;
  /** Seconds the price takes to fall. Ignored for a fixed price. */
  fallSeconds: bigint;
  /** Seconds from now until the listing expires. */
  lifeSeconds: bigint;
}

export const MIN_LIFE_SECONDS = 600n;
export const MAX_LIFE_SECONDS = 30n * 24n * 3600n;

/** Builds the listing and the reasons it cannot be signed, mirroring the BadParams rule in `check`. */
export function buildListing(f: ListingForm): { listing?: Listing; errors: string[] } {
  const errors: string[] = [];
  if (!f.startPrice) errors.push("Enter a price.");
  if (f.kind === "dutch" && !f.endPrice) errors.push("Enter the lowest price the auction falls to.");
  if (f.lifeSeconds < MIN_LIFE_SECONDS) errors.push("A listing has to stay open for at least ten minutes.");
  if (f.lifeSeconds > MAX_LIFE_SECONDS) errors.push("A listing can stay open for at most 30 days.");
  if (f.kind === "dutch" && f.fallSeconds <= 0n) errors.push("The price has to take some time to fall.");
  if (f.kind === "dutch" && f.fallSeconds > f.lifeSeconds) errors.push("The price has to reach its lowest point before the listing expires.");
  if (f.kind === "dutch" && f.startPrice && f.endPrice && f.endPrice >= f.startPrice) {
    errors.push("The lowest price must be under the starting price. For one price, choose fixed.");
  }
  if (errors.length || !f.startPrice) return { errors };
  const endPrice = f.kind === "fixed" ? f.startPrice : f.endPrice!;
  const startTime = f.now;
  const listing: Listing = {
    seller: f.seller,
    tokenId: f.tokenId,
    epoch: f.epoch,
    startPrice: f.startPrice,
    endPrice,
    startTime,
    endTime: f.kind === "fixed" ? startTime : startTime + f.fallSeconds,
    deadline: startTime + f.lifeSeconds,
    nonce: f.nonce,
    salt: f.salt,
  };
  return { listing, errors };
}

/** What the buyer sees a position to be at the moment they decide. */
export interface Seen {
  epoch: bigint;
  coll: bigint;
  debt: bigint;
  rateBps: number;
  reserveBtc: bigint;
  reserveMusd: bigint;
}

/**
 * The bounds a buyer signs up to. They are exactly what was on screen, with a little headroom only
 * where the number moves by itself: interest raises debt every second until the sale lands.
 * The price cap is the price now, which a Dutch auction can only lower.
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

/** Turns a market custom error into a sentence. `args` are the decoded error arguments. */
export function marketErrorText(name: string, args: readonly unknown[] | undefined): string | undefined {
  const a = args ?? [];
  switch (name) {
    case "ListingInvalid":
      return stateText(stateName(a[0] as bigint | number));
    case "EpochMismatch":
      return "The position changed hands since this listing was signed.";
    case "CollateralBelowMin":
      return `The position now holds less collateral than you agreed to buy (${formatMusd(a[0] as bigint)} against at least ${formatMusd(a[1] as bigint)}).`;
    case "DebtAboveMax":
      return `The position's debt rose above your limit (${formatMusd(a[0] as bigint)} against at most ${formatMusd(a[1] as bigint)} MUSD).`;
    case "RateOutOfRange":
      return `The position's interest rate changed to ${(Number(a[0]) / 100).toFixed(2)}%, outside the range you accepted.`;
    case "ReserveBelowMin":
      return "The seller emptied the guardian reserve after listing. Nothing was spent.";
    case "PriceAboveMax":
      return `The price is ${formatMusd(a[0] as bigint)} MUSD, above the most you allowed.`;
    case "NotSeller":
      return "Only the seller can cancel this listing.";
    case "AlreadyClosed":
      return "This listing is already sold or cancelled.";
    default:
      return undefined;
  }
}
