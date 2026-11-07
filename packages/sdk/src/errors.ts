import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi } from "viem";
import { factoryAbi, marketAbi, nftAbi, vaultAbi } from "./generated/abis.js";
import { formatAmount, formatBps } from "./format.js";
import { MARKET_STATES, type MarketState } from "./types.js";

export type TrozuErrorCode =
  | "REVERT"
  | "VALIDATION"
  | "NOT_FOUND"
  | "RPC"
  | "UNKNOWN";

/** Base class. Catch this to catch everything the SDK throws on purpose. */
export class TrozuError extends Error {
  readonly code: TrozuErrorCode;
  constructor(code: TrozuErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The caller passed something the SDK refuses to encode. Nothing was sent anywhere. */
export class TrozuValidationError extends TrozuError {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super("VALIDATION", issues.join("; "));
    this.issues = issues;
  }
}

export class TrozuNotFoundError extends TrozuError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("NOT_FOUND", message, options);
  }
}

/** The node did not answer, or answered garbage. Retry later; nothing says the call itself was wrong. */
export class TrozuRpcError extends TrozuError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("RPC", message, options);
  }
}

export type RevertSource = "vault" | "market" | "factory" | "nft" | "mezo" | "unknown";

/**
 * A contract refused the call. `errorName` is the custom error (or "MezoRefusal" for Mezo's string
 * reverts), `args` are its decoded arguments. `message` is always a sentence the SDK wrote from the
 * numbers; any text that came from the chain lives in `chainText` and must be treated as untrusted.
 */
export class TrozuRevertError extends TrozuError {
  readonly errorName: string;
  readonly args: readonly unknown[];
  readonly source: RevertSource;
  readonly chainText?: string;
  constructor(errorName: string, args: readonly unknown[], source: RevertSource, message: string, chainText?: string, options?: { cause?: unknown }) {
    super("REVERT", message, options);
    this.errorName = errorName;
    this.args = args;
    this.source = source;
    this.chainText = chainText;
  }
}

/** `ListingInvalid(state)`: the market's own reason a listing cannot settle. */
export class ListingInvalidError extends TrozuRevertError {
  readonly state: MarketState;
  constructor(state: MarketState, args: readonly unknown[], cause?: unknown) {
    super("ListingInvalid", args, "market", stateSentence(state), undefined, { cause });
    this.state = state;
  }
}

/** `BadPolicy(reason)` from `setPolicy`. `chainText` carries the contract's reason string. */
export class BadPolicyError extends TrozuRevertError {
  constructor(reason: string, args: readonly unknown[], cause?: unknown) {
    super("BadPolicy", args, "vault", "The vault refused this guardian policy.", reason, { cause });
  }
}

/** A buyer's bound failed: the position moved between the quote and the sale. Nothing was spent. */
export class BoundsError extends TrozuRevertError {
  readonly field: "epoch" | "collateral" | "debt" | "rate" | "reserve" | "price";
  constructor(errorName: string, field: BoundsError["field"], args: readonly unknown[], message: string, cause?: unknown) {
    super(errorName, args, "market", message, undefined, { cause });
    this.field = field;
  }
}

export const stateName = (i: number | bigint): MarketState => MARKET_STATES[Number(i)] ?? "BadParams";

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

export const stateSentence = (s: MarketState) => STATE_TEXT[s];

const asBig = (v: unknown) => (typeof v === "bigint" ? v : BigInt(Number(v) || 0));
const amt = (v: unknown) => formatAmount(asBig(v), 5);

/** Plain sentences for the custom errors the contracts declare. Anything not listed falls through to a generic line. */
const SENTENCES: Record<string, (a: readonly unknown[]) => string> = {
  // market
  EpochMismatch: () => "The position changed hands since this listing was signed.",
  CollateralBelowMin: (a) => `The position now holds less collateral than agreed (${amt(a[0])} against at least ${amt(a[1])}).`,
  DebtAboveMax: (a) => `The position's debt rose above the limit (${amt(a[0])} against at most ${amt(a[1])}).`,
  RateOutOfRange: (a) => `The position's interest rate is ${formatBps(Number(a[0]))}, outside the accepted range.`,
  ReserveBelowMin: () => "The seller emptied the guardian reserve after listing. Nothing was spent.",
  PriceAboveMax: (a) => `The price is ${amt(a[0])}, above the most allowed (${amt(a[1])}).`,
  NotSeller: () => "Only the seller can cancel this listing.",
  AlreadyClosed: () => "This listing is already sold or cancelled.",
  FeeTooHigh: () => "A fee was above the limit that was set.",
  ZeroAddress: () => "An address argument was the zero address.",
  // vault
  NotHolder: () => "Only the current holder of the position NFT can do this.",
  NothingToDo: () => "The guardian has nothing to do right now.",
  NoRateImprovement: (a) => `The market rate (${formatBps(Number(a[1]))}) is not below this position's locked rate (${formatBps(Number(a[0]))}), so refinancing would not help.`,
  RateNotUpdated: () => "The position's rate has not changed after the refinance.",
  RefinanceFeeTooHigh: (a) => `The refinancing fee (${amt(a[0])}) is above the limit (${amt(a[1])}).`,
  DebtCapExceeded: (a) => `This deployment caps what one position can owe, and this would go over it (${amt(a[0])} against ${amt(a[1])}).`,
  ReserveTooSmall: () => "The reserve is too small for this.",
  ReserveInvariant: () => "That would take the reserve below what the guardian needs.",
  BtcTransferFailed: () => "Sending BTC failed.",
  AlreadyInitialized: () => "This vault is already initialised.",
  OnlyFactory: () => "Only the factory can call this.",
  UnexpectedSender: () => "BTC was sent from an address the vault does not accept.",
  InsufficientBalance: () => "The wallet does not hold enough BTC for this.",
  ReentrancyGuardReentrantCall: () => "Reentrant call.",
  SafeERC20FailedOperation: () => "A token transfer failed. Check the balance and allowance.",
  // nft
  ERC721InvalidReceiver: () => "The NFT could not be moved. The receiver may be a contract that cannot hold NFTs.",
  ERC721IncorrectOwner: () => "The sender does not own this position NFT.",
  ERC721InsufficientApproval: () => "The caller is not approved to move this position NFT.",
  ERC721NonexistentToken: () => "That position does not exist.",
};

const BOUNDS: Record<string, BoundsError["field"]> = {
  EpochMismatch: "epoch",
  CollateralBelowMin: "collateral",
  DebtAboveMax: "debt",
  RateOutOfRange: "rate",
  ReserveBelowMin: "reserve",
  PriceAboveMax: "price",
};

const sourceOf = (name: string): RevertSource => {
  const has = (abi: Abi) => abi.some((x) => x.type === "error" && x.name === name);
  if (has(marketAbi as Abi)) return "market";
  if (has(vaultAbi as Abi)) return "vault";
  if (has(factoryAbi as Abi)) return "factory";
  if (has(nftAbi as Abi)) return "nft";
  return "unknown";
};

/** Builds the typed error for a decoded custom error. */
export function revertFromNamed(name: string, args: readonly unknown[] = [], cause?: unknown): TrozuRevertError {
  if (name === "ListingInvalid") return new ListingInvalidError(stateName(asBig(args[0])), args, cause);
  if (name === "BadPolicy") return new BadPolicyError(String(args[0] ?? ""), args, cause);
  const sentence = SENTENCES[name];
  const message = sentence ? sentence(args) : `The contract reverted with ${name}.`;
  const field = BOUNDS[name];
  if (field) return new BoundsError(name, field, args, message, cause);
  return new TrozuRevertError(name, args, sourceOf(name), message, undefined, { cause });
}

const allErrorsAbi = [...vaultAbi, ...marketAbi, ...factoryAbi, ...nftAbi].filter((x) => x.type === "error") as unknown as Abi;

/** Mezo's own contracts revert with strings, not custom errors. These are the ones worth a sentence. */
const MEZO_TEXT: [RegExp, string][] = [
  [/TCR < CCR/, "Mezo refused it: it would push the whole system under 150% collateral. Use more collateral or borrow less."],
  [/ICR.*MCR|MCR.*ICR|below.*minimum collateral/i, "Mezo refused it: the trove would end up under 110% collateral."],
  [/net debt.*(minimum|MIN)/i, "Mezo refused it: the debt would be under the minimum a trove must carry."],
];

const NETWORK = /HTTP request failed|unknown RPC error|fetch failed|Failed to fetch|timed out|ECONNRESET|ECONNREFUSED|socket hang up/i;

/**
 * Turns whatever a viem call threw into one of the SDK's typed errors. Safe to call on anything:
 * an error that is already a TrozuError comes back as it is.
 */
export function decodeRevert(e: unknown): TrozuError {
  if (e instanceof TrozuError) return e;

  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.data) return revertFromNamed(reverted.data.errorName, reverted.data.args ?? [], e);
      // a plain `revert("text")` or an empty revert
      const text = reverted.reason ?? reverted.shortMessage;
      return mezoOrUnknown(text, e);
    }
    const raw = findRevertData(e);
    if (raw) {
      try {
        const d = decodeErrorResult({ abi: allErrorsAbi, data: raw });
        return revertFromNamed(d.errorName, (d.args as readonly unknown[] | undefined) ?? [], e);
      } catch {
        // not one of ours, fall through
      }
    }
    return mezoOrUnknown(`${e.shortMessage} ${e.message}`, e);
  }
  return mezoOrUnknown(e instanceof Error ? e.message : String(e), e);
}

function mezoOrUnknown(text: string, cause: unknown): TrozuError {
  for (const [re, sentence] of MEZO_TEXT) {
    if (re.test(text)) return new TrozuRevertError("MezoRefusal", [], "mezo", sentence, text.slice(0, 300), { cause });
  }
  if (NETWORK.test(text)) {
    return new TrozuRpcError("The network node did not answer. If a transaction was sent it may still land, so check the explorer before trying again.", { cause });
  }
  return new TrozuError("UNKNOWN", "The call failed for a reason the SDK does not recognise.", { cause });
}

/** Revert data some nodes put on the error as `data` instead of in viem's decoded shape. */
function findRevertData(e: BaseError): `0x${string}` | undefined {
  let cur: unknown = e;
  for (let i = 0; cur && i < 8; i++) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) return d as `0x${string}`;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
