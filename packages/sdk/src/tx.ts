import { encodeFunctionData, parseAbi, zeroHash, type Abi } from "viem";
import { toAddress, toUint, ZERO } from "./context.js";
import { TrozuValidationError } from "./errors.js";
import { gasLimitFor, type GasOptions } from "./gas.js";
import { factoryAbi, marketAbi, nftAbi, vaultAbi } from "./generated/abis.js";
import { formatAmount } from "./format.js";
import { validatePolicy } from "./math.js";
import type { Address, Bounds, Deployment, Hex, Listing, Permit, PolicyInput, UnsignedTx } from "./types.js";

const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

type Hints = readonly [Address | string, Address | string];

const NO_PERMIT: Permit = { deadline: 0n, v: 0, r: zeroHash, s: zeroHash };
const U16 = 0xffffn;
const U64 = 2n ** 64n - 1n;

const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const btc = (v: bigint) => `${formatAmount(v)} BTC`;
const musd = (v: bigint) => `${formatAmount(v, 2)} MUSD`;

/**
 * Unsigned transaction builders. Every one returns `{ chainId, to, data, value, gas }` and nothing
 * else: no signing, no sending, no key. The gas limit is always set, from the proof-run table in
 * gas.ts, because the node's estimateGas cannot be trusted on Mezo.
 *
 * Inputs are checked before anything is encoded and a bad one throws `TrozuValidationError` with every
 * problem listed. Sorted-list hints are optional: without them Mezo walks from the head of its list,
 * which costs more gas but never reverts (see hints.ts to compute them).
 */
export function txBuilders(deployment: Deployment) {
  const chainId = deployment.chainId;

  function make(
    to: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    summary: string,
    extra: { value?: bigint; gas?: GasOptions } = {},
  ): UnsignedTx {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    return { chainId, to, data, value: extra.value ?? 0n, gas: BigInt(gasLimitFor(functionName, extra.gas)), functionName, summary };
  }

  /** Runs the checks, collecting every issue, and throws once. */
  function check<T>(f: (bad: (m: string) => void) => T): T {
    const issues: string[] = [];
    let result: T | undefined;
    try {
      result = f((m) => issues.push(m));
    } catch (e) {
      if (e instanceof TrozuValidationError) issues.push(...e.issues);
      else throw e;
    }
    if (issues.length) throw new TrozuValidationError(issues);
    return result as T;
  }

  const hintPair = (h: Hints | undefined): [Address, Address] => (h ? [toAddress("upperHint", h[0]), toAddress("lowerHint", h[1])] : [ZERO, ZERO]);
  const positive = (name: string, v: bigint, bad: (m: string) => void) => {
    if (v === 0n) bad(`${name} has to be above zero`);
  };

  // ---- owner actions, on the position's vault ------------------------------------------------------------

  return {
    /** Opens a position through the factory. `collateral` is sent as the transaction's value. */
    openPosition(a: { debt: bigint | string; collateral: bigint | string; maxFee: bigint | string; hints?: Hints }): UnsignedTx {
      return check((bad) => {
        const debt = toUint("debt", a.debt);
        const collateral = toUint("collateral", a.collateral);
        const maxFee = toUint("maxFee", a.maxFee);
        positive("debt", debt, bad);
        positive("collateral", collateral, bad);
        const [up, lo] = hintPair(a.hints);
        return make(deployment.trozu.factory, factoryAbi, "openPosition", [debt, up, lo, maxFee], `Open a position: lock ${btc(collateral)} and borrow ${musd(debt)}, fee at most ${musd(maxFee)}.`, { value: collateral });
      });
    },

    addCollateral(a: { vault: string; amount: bigint | string; hints?: Hints; gas?: GasOptions }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        const [up, lo] = hintPair(a.hints);
        return make(vault, vaultAbi, "addCollateral", [up, lo], `Add ${btc(amount)} of collateral to the position at ${short(vault)}.`, { value: amount, gas: a.gas });
      });
    },

    withdrawCollateral(a: { vault: string; amount: bigint | string; hints?: Hints; gas?: GasOptions }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        const [up, lo] = hintPair(a.hints);
        return make(vault, vaultAbi, "withdrawCollateral", [amount, up, lo], `Withdraw ${btc(amount)} of collateral from the position at ${short(vault)}.`, { gas: a.gas });
      });
    },

    borrow(a: { vault: string; amount: bigint | string; maxFee: bigint | string; hints?: Hints; gas?: GasOptions }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        const maxFee = toUint("maxFee", a.maxFee);
        positive("amount", amount, bad);
        const [up, lo] = hintPair(a.hints);
        return make(vault, vaultAbi, "borrow", [amount, up, lo, maxFee], `Borrow ${musd(amount)} more on the position at ${short(vault)}, fee at most ${musd(maxFee)}.`, { gas: a.gas });
      });
    },

    /** Repays MUSD from the holder's wallet. The vault needs an MUSD allowance first (`approveMusd`). */
    repay(a: { vault: string; amount: bigint | string; hints?: Hints; gas?: GasOptions }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        const [up, lo] = hintPair(a.hints);
        return make(vault, vaultAbi, "repay", [amount, up, lo], `Repay ${musd(amount)} on the position at ${short(vault)}.`, { gas: a.gas });
      });
    },

    repayWithPermit(a: { vault: string; amount: bigint | string; permit: Permit; hints?: Hints; gas?: GasOptions }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        const p = permitOf(a.permit);
        const [up, lo] = hintPair(a.hints);
        return make(vault, vaultAbi, "repayWithPermit", [amount, up, lo, p.deadline, p.v, p.r, p.s], `Repay ${musd(amount)} on the position at ${short(vault)}, approving MUSD by signature.`, { gas: a.gas });
      });
    },

    /** Moves the position to today's market rate if it is lower. Reverts with NoRateImprovement if it is not. */
    refinance(a: { vault: string; maxFee: bigint | string; minRateDropBps?: number; hints?: Hints; gas?: GasOptions }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const maxFee = toUint("maxFee", a.maxFee);
        const drop = toUint("minRateDropBps", a.minRateDropBps ?? 0, U16);
        const [up, lo] = hintPair(a.hints);
        void bad;
        return make(vault, vaultAbi, "refinance", [up, lo, maxFee, Number(drop)], `Refinance the position at ${short(vault)} to the current market rate, fee at most ${musd(maxFee)}.`, { gas: a.gas });
      });
    },

    /** Closes the position. The wallet needs MUSD for the debt and an allowance for the vault (`approveMusd`). */
    close(a: { vault: string; gas?: GasOptions }): UnsignedTx {
      return check(() => {
        const vault = toAddress("vault", a.vault);
        return make(vault, vaultAbi, "close", [], `Close the position at ${short(vault)}: repay the debt and take back the collateral.`, { gas: a.gas });
      });
    },

    closeWithPermit(a: { vault: string; permit: Permit; gas?: GasOptions }): UnsignedTx {
      return check(() => {
        const vault = toAddress("vault", a.vault);
        const p = permitOf(a.permit);
        return make(vault, vaultAbi, "closeWithPermit", [p.deadline, p.v, p.r, p.s], `Close the position at ${short(vault)}, approving MUSD by signature.`, { gas: a.gas });
      });
    },

    claimSurplus(a: { vault: string }): UnsignedTx {
      const vault = toAddress("vault", a.vault);
      return make(vault, vaultAbi, "claimSurplus", [], `Claim the leftover collateral of the position at ${short(vault)}.`);
    },

    /** Sends a token the vault holds by accident back to the holder. */
    sweep(a: { vault: string; token: string }): UnsignedTx {
      return check(() => {
        const vault = toAddress("vault", a.vault);
        const token = toAddress("token", a.token);
        return make(vault, vaultAbi, "sweep", [token], `Sweep token ${short(token)} out of the vault at ${short(vault)}.`);
      });
    },

    // ---- guardian ---------------------------------------------------------------------------------------

    /** Sets or replaces the guardian policy. Throws with every reason the vault would refuse it for. */
    setPolicy(a: { vault: string; policy: PolicyInput; gas?: GasOptions }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const p = a.policy;
        for (const k of ["floorIcr", "targetIcr", "maxActionBtc", "maxActionMusd", "periodCapBtc", "periodCapMusd", "keeperTipBtc", "bufferFloorMusd"] as const) toUint(`policy.${k}`, p[k]);
        toUint("policy.period", p.period, 2n ** 32n - 1n);
        toUint("policy.maxWalkSteps", p.maxWalkSteps, U16);
        for (const issue of validatePolicy(p)) bad(issue);
        const tuple = { epoch: 0n, ...p, active: false };
        return make(vault, vaultAbi, "setPolicy", [tuple], `Set the guardian policy on the position at ${short(vault)}: act below ${Number((p.floorIcr * 10_000n) / 10n ** 18n) / 100}% and restore to ${Number((p.targetIcr * 10_000n) / 10n ** 18n) / 100}%.`, { gas: a.gas });
      });
    },

    clearPolicy(a: { vault: string }): UnsignedTx {
      const vault = toAddress("vault", a.vault);
      return make(vault, vaultAbi, "clearPolicy", [], `Switch the guardian off for the position at ${short(vault)}.`);
    },

    fundReserveBtc(a: { vault: string; amount: bigint | string }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        return make(vault, vaultAbi, "fundReserveBtc", [], `Put ${btc(amount)} into the guardian reserve of the position at ${short(vault)}.`, { value: amount });
      });
    },

    /** Needs an MUSD allowance for the vault first (`approveMusd`). */
    fundReserveMusd(a: { vault: string; amount: bigint | string }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        return make(vault, vaultAbi, "fundReserveMusd", [amount], `Put ${musd(amount)} into the guardian reserve of the position at ${short(vault)}.`);
      });
    },

    fundReserveMusdWithPermit(a: { vault: string; amount: bigint | string; permit: Permit }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        const p = permitOf(a.permit);
        return make(vault, vaultAbi, "fundReserveMusdWithPermit", [amount, p.deadline, p.v, p.r, p.s], `Put ${musd(amount)} into the guardian reserve of the position at ${short(vault)}, approving MUSD by signature.`);
      });
    },

    withdrawReserveBtc(a: { vault: string; amount: bigint | string }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        return make(vault, vaultAbi, "withdrawReserveBtc", [amount], `Take ${btc(amount)} back out of the guardian reserve of the position at ${short(vault)}.`);
      });
    },

    withdrawReserveMusd(a: { vault: string; amount: bigint | string }): UnsignedTx {
      return check((bad) => {
        const vault = toAddress("vault", a.vault);
        const amount = toUint("amount", a.amount);
        positive("amount", amount, bad);
        return make(vault, vaultAbi, "withdrawReserveMusd", [amount], `Take ${musd(amount)} back out of the guardian reserve of the position at ${short(vault)}.`);
      });
    },

    /**
     * The guardian's own call. Anyone can send it; it only does what the holder's policy allows and pays
     * the keeper tip. Set `gas: { defenseWalk: true }` when the policy has a redemption-defense floor.
     */
    execute(a: { vault: string; hints?: Hints; gas?: GasOptions }): UnsignedTx {
      return check(() => {
        const vault = toAddress("vault", a.vault);
        const [up, lo] = hintPair(a.hints);
        return make(vault, vaultAbi, "execute", [up, lo], `Run the guardian for the position at ${short(vault)}: it acts only if the holder's policy says so.`, { gas: a.gas });
      });
    },

    // ---- tokens and the NFT ------------------------------------------------------------------------------

    /** MUSD allowance for a spender, usually the vault (repay, close, reserve) or the market (buy). */
    approveMusd(a: { spender: string; amount: bigint | string }): UnsignedTx {
      return check(() => {
        const spender = toAddress("spender", a.spender);
        const amount = toUint("amount", a.amount);
        return make(deployment.mezo.musd, erc20Abi as unknown as Abi, "approve", [spender, amount], `Let ${short(spender)} spend up to ${musd(amount)} from your wallet.`);
      });
    },

    /** Lets the market move one position NFT, which a listing needs before it can sell. */
    approveMarketFor(a: { tokenId: bigint | string }): UnsignedTx {
      const id = toUint("tokenId", a.tokenId);
      return make(deployment.trozu.nft, nftAbi, "approve", [deployment.trozu.market, id], `Let the Trozu market move position #${id}, so it can be sold.`);
    },

    /** Sends the position NFT, and with it the position, to another address. */
    transferPosition(a: { from: string; to: string; tokenId: bigint | string }): UnsignedTx {
      return check((bad) => {
        const from = toAddress("from", a.from);
        const to = toAddress("to", a.to);
        const id = toUint("tokenId", a.tokenId);
        if (to === ZERO) bad("to cannot be the zero address");
        return make(deployment.trozu.nft, nftAbi, "safeTransferFrom", [from, to, id], `Transfer position #${id} from ${short(from)} to ${short(to)}. The new holder gets the position and its collateral.`);
      });
    },

    // ---- market ------------------------------------------------------------------------------------------

    /** Publishes a signed listing. The seller signs the EIP-712 `Listing` elsewhere; this only announces it. */
    announce(a: { listing: Listing; signature: Hex }): UnsignedTx {
      return check(() => {
        const l = listingOf(a.listing);
        return make(deployment.trozu.market, marketAbi, "announce", [l, sigOf(a.signature)], `Announce the listing of position #${l.tokenId}.`);
      });
    },

    cancel(a: { listing: Listing }): UnsignedTx {
      return check(() => {
        const l = listingOf(a.listing);
        return make(deployment.trozu.market, marketAbi, "cancel", [l], `Cancel the listing of position #${l.tokenId}.`);
      });
    },

    cancelAll(): UnsignedTx {
      return make(deployment.trozu.market, marketAbi, "cancelAll", [], "Cancel every listing you have signed.");
    },

    /** Buys a listed position. The buyer needs an MUSD allowance for the market (`approveMusd`). */
    buy(a: { listing: Listing; signature: Hex; bounds: Bounds; recipient: string; permit?: Permit }): UnsignedTx {
      return check((bad) => {
        const l = listingOf(a.listing);
        const sig = sigOf(a.signature);
        const recipient = toAddress("recipient", a.recipient);
        if (recipient === ZERO) bad("recipient cannot be the zero address");
        const b = boundsOf(a.bounds);
        const p = a.permit ? permitOf(a.permit) : NO_PERMIT;
        return make(deployment.trozu.market, marketAbi, "buy", [l, sig, b, recipient, p], `Buy position #${l.tokenId} for at most ${musd(b.maxPrice)}, sent to ${short(recipient)}.`);
      });
    },
  };
}

export type TxBuilders = ReturnType<typeof txBuilders>;

function permitOf(p: Permit): Permit {
  return {
    deadline: toUint("permit.deadline", p.deadline),
    v: Number(toUint("permit.v", p.v, 255n)),
    r: bytes32("permit.r", p.r),
    s: bytes32("permit.s", p.s),
  };
}

function bytes32(name: string, v: unknown): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new TrozuValidationError([`${name} is not a 32-byte hex string`]);
  return v as Hex;
}

/** A signature is 65 bytes for an EOA. Contract wallets can sign longer, so the cap is loose. */
function sigOf(v: unknown): Hex {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2}){1,2048}$/.test(v)) throw new TrozuValidationError(["signature is not hex of up to 2048 bytes"]);
  return v as Hex;
}

function listingOf(l: Listing): Listing {
  return {
    seller: toAddress("listing.seller", l.seller),
    tokenId: toUint("listing.tokenId", l.tokenId),
    epoch: toUint("listing.epoch", l.epoch),
    startPrice: toUint("listing.startPrice", l.startPrice),
    endPrice: toUint("listing.endPrice", l.endPrice),
    startTime: toUint("listing.startTime", l.startTime, U64),
    endTime: toUint("listing.endTime", l.endTime, U64),
    deadline: toUint("listing.deadline", l.deadline, U64),
    nonce: toUint("listing.nonce", l.nonce),
    salt: toUint("listing.salt", l.salt),
  };
}

function boundsOf(b: Bounds): Bounds {
  return {
    expectedEpoch: toUint("bounds.expectedEpoch", b.expectedEpoch),
    minColl: toUint("bounds.minColl", b.minColl),
    maxDebt: toUint("bounds.maxDebt", b.maxDebt),
    minRateBps: Number(toUint("bounds.minRateBps", b.minRateBps, U16)),
    maxRateBps: Number(toUint("bounds.maxRateBps", b.maxRateBps, U16)),
    maxPrice: toUint("bounds.maxPrice", b.maxPrice),
    minReserveBtc: toUint("bounds.minReserveBtc", b.minReserveBtc),
    minReserveMusd: toUint("bounds.minReserveMusd", b.minReserveMusd),
  };
}
