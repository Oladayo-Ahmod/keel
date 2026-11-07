import type { Address, Hex } from "viem";

export type { Address, Hex };

/** The addresses the SDK talks to. `matsnetDeployment` in this package is one of these. */
export interface Deployment {
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly explorer: string;
  readonly deployedAtBlock: number;
  readonly trozu: {
    readonly factory: Address;
    readonly nft: Address;
    readonly lens: Address;
    readonly vaultImplementation: Address;
    readonly market: Address;
  };
  readonly market: {
    readonly feeBps: number;
    readonly maxFeeBps: number;
    readonly feeRecipient: Address;
  };
  readonly mezo: {
    readonly borrowerOperations: Address;
    readonly troveManager: Address;
    readonly sortedTroves: Address;
    readonly interestRateManager: Address;
    readonly collSurplusPool: Address;
    readonly activePool: Address;
    readonly priceFeed: Address;
    readonly musd: Address;
    readonly hintHelpers: Address;
  };
}

/** Everything amounts-wise is a bigint in wei (BTC and MUSD both have 18 decimals). Ratios are 1e18 fixed point, 1.6e18 is 160%. */

export type RiskLevel = "none" | "safe" | "caution" | "danger" | "liquidatable";

/** `PositionLens.positionInfo` plus a risk label worked out from the ratio. */
export interface PositionView {
  tokenId: bigint;
  vault: Address;
  holder: Address;
  /** False when the position has no open trove (closed, or never opened). */
  active: boolean;
  collateral: bigint;
  principal: bigint;
  interest: bigint;
  debt: bigint;
  priceOk: boolean;
  /** BTC price in MUSD, 1e18. Zero when the feed did not answer. */
  price: bigint;
  /** 1e18 ratio. At or above 2^200 it means there is no debt. */
  icr: bigint;
  hasDebt: boolean;
  /** Collateral value minus debt, in MUSD wei. Negative when under water. */
  equity: bigint;
  /** The rate this position locked in when it opened, in basis points. */
  lockedRateBps: number;
  /** The rate Mezo charges a new borrower today. */
  marketRateBps: number;
  /** market minus locked, as the Lens computes it. Positive means the locked rate is cheaper than a new borrower's. */
  spreadBps: bigint;
  /** principal times the spread over a year at today's rate, not discounted, in MUSD wei. Positive means the locked rate saves that much. */
  annualSpreadMusd: bigint;
  claimableSurplus: bigint;
  refinanceFeeEstimate: bigint;
  redeemable: boolean;
  recoveryMode: boolean;
  canClose: boolean;
  risk: RiskLevel;
}

export interface BufferView {
  /** MUSD that has to be redeemed before this position is reached. */
  buffer: bigint;
  eligibleAhead: bigint;
  steps: bigint;
  /** False when the walk stopped at its step limit, so `buffer` is a lower bound. */
  complete: boolean;
  inList: boolean;
}

export type BufferVerdict = "unknown" | "above" | "below";

export interface BufferCheck extends BufferView {
  verdict: BufferVerdict;
  threshold: bigint;
}

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

/** Mirrors `TrozuMarket.Bounds`: what a buyer insists on, checked in the same transaction as the payment. */
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

export interface Permit {
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/** `TrozuMarket.State`, in declaration order. */
export const MARKET_STATES = [
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
export type MarketState = (typeof MARKET_STATES)[number];

export interface ListingView {
  hash: Hex;
  listing: Listing;
  signature: Hex;
  state: MarketState;
  /** True when `buy` would accept it right now. */
  open: boolean;
  dutch: boolean;
  /** Price at the latest block's time. Null when the listing's own numbers make the curve meaningless (BadParams). */
  priceNow: bigint | null;
  feeNow: bigint | null;
  sellerReceives: bigint | null;
  announcedAtBlock: bigint;
  announcedTx: Hex;
}

export interface Quote {
  hash: Hex;
  state: MarketState;
  open: boolean;
  /** Chain time the price was worked out at. */
  at: bigint;
  price: bigint | null;
  fee: bigint | null;
  sellerReceives: bigint | null;
  /** The bounds a careful buyer would sign up to, from what the position looks like now. Undefined if the position cannot be read. */
  bounds?: Bounds;
  position?: PositionView;
}

export type PolicyKind = "None" | "TopUpBtc" | "RepayMusd" | "DefendBtc";
export type PolicyReason =
  | "None"
  | "NoPolicy"
  | "PolicyStale"
  | "TroveInactive"
  | "NoPrice"
  | "Healthy"
  | "BufferUnknown"
  | "NoReserve"
  | "BelowMinimum";

/** Mirrors `TrozuVault.Policy`. */
export interface PolicyView {
  epoch: bigint;
  floorIcr: bigint;
  targetIcr: bigint;
  maxActionBtc: bigint;
  maxActionMusd: bigint;
  periodCapBtc: bigint;
  periodCapMusd: bigint;
  keeperTipBtc: bigint;
  bufferFloorMusd: bigint;
  period: number;
  maxWalkSteps: number;
  active: boolean;
}

/** What the policy fields are when a holder writes one. `epoch` and `active` are set by the vault. */
export type PolicyInput = Omit<PolicyView, "epoch" | "active">;

/** What a call to `execute` would do right now, from `TrozuVault.preview`. */
export interface PlanView {
  kind: PolicyKind;
  reason: PolicyReason;
  amount: bigint;
  tip: bigint;
  icr: bigint;
  resetWindow: boolean;
}

export interface GuardianStatus {
  tokenId: bigint;
  vault: Address;
  policy: PolicyView;
  /** The policy is set and was written by the current holder. */
  live: boolean;
  plan: PlanView;
  reserve: { btc: bigint; musd: bigint };
  /** Spent in the current period. Already zero if the window has rolled over. */
  spent: { btc: bigint; musd: bigint };
  /** What is left of the period caps. */
  allowance: { btc: bigint; musd: bigint };
  periodStart: bigint;
  windowResets: bigint;
  /** icr minus floorIcr, 1e18. Null when there is no live policy or no debt. Negative means under the floor. */
  marginToFloor: bigint | null;
}

export interface UnsignedTx {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  /** Always set. The node's estimateGas is unreliable on Mezo, so wallets must not replace it. */
  gas: bigint;
  functionName: string;
  /** A sentence made by the SDK from the arguments, never from chain text. */
  summary: string;
}
