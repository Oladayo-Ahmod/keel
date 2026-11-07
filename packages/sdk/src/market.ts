import { getAbiItem } from "viem";
import { guarded, toUint, vaultOf, type Context } from "./context.js";
import { stateName } from "./errors.js";
import { marketAbi, nftAbi, vaultAbi } from "./generated/abis.js";
import { defaultBounds, feeOn, isDutch, priceAt } from "./math.js";
import { lensReads } from "./lens.js";
import type { Hex, Listing, ListingView, PositionView, Quote } from "./types.js";

/** Mezo's public RPC rejects eth_getLogs over 10,000 blocks, so logs are read in windows. */
export const LOG_WINDOW = 9_000n;
const announced = getAbiItem({ abi: marketAbi, name: "ListingAnnounced" });

export interface ListingsOptions {
  /** Only listings of this position. */
  tokenId?: bigint | number | string;
  /** Keep only listings `buy` would accept right now. Default false, so a caller can see why one is not. */
  onlyOpen?: boolean;
  /** Most listings to return, newest first. Default 50, at most 200. */
  limit?: number;
  /** How far back to look. Default 50,000 blocks, never before the market was deployed. */
  lookbackBlocks?: number;
  /** The most announcements to examine, whatever the limit. Each costs one eth_call. Default 300. */
  maxScan?: number;
  /** Chain time to price at. Default is the latest block's timestamp. */
  now?: bigint;
}

const tupleOf = (l: Listing) => l;

export function marketReads(ctx: Context) {
  const { client, deployment } = ctx;
  const market = deployment.trozu.market;
  const lens = lensReads(ctx);

  async function chainNow(): Promise<bigint> {
    return (await guarded(() => client.getBlock({ blockTag: "latest" }))).timestamp;
  }

  async function check(listing: Listing, signature: Hex) {
    const s = await guarded(() => client.readContract({ address: market, abi: marketAbi, functionName: "check", args: [tupleOf(listing), signature] }));
    return stateName(s);
  }

  function pricing(listing: Listing, at: bigint) {
    try {
      const price = priceAt(listing, at);
      const fee = feeOn(price, deployment.market.feeBps);
      return { price, fee, sellerReceives: price - fee };
    } catch {
      // a listing whose numbers make no sense (BadParams) has no meaningful price
      return { price: null, fee: null, sellerReceives: null };
    }
  }

  /**
   * Announced listings, newest first, each checked against the market's own `check`. The announcement
   * log is written by whoever calls `announce`, so everything in it is untrusted until `check` agrees.
   */
  async function listings(o: ListingsOptions = {}): Promise<ListingView[]> {
    const limit = Math.min(Math.max(Math.trunc(o.limit ?? 50), 1), 200);
    const maxScan = Math.min(Math.max(Math.trunc(o.maxScan ?? 300), 1), 2000);
    const lookback = BigInt(Math.min(Math.max(Math.trunc(o.lookbackBlocks ?? 50_000), 1), 2_000_000));
    const tokenFilter = o.tokenId === undefined ? undefined : toUint("tokenId", o.tokenId);

    const latest = await guarded(() => client.getBlockNumber());
    const deployed = BigInt(deployment.deployedAtBlock);
    const floor = latest - lookback + 1n > deployed ? latest - lookback + 1n : deployed;
    const now = o.now ?? (await chainNow());

    const out: ListingView[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    for (let end = latest; end >= floor && out.length < limit && scanned < maxScan; end -= LOG_WINDOW) {
      const start = end - LOG_WINDOW + 1n > floor ? end - LOG_WINDOW + 1n : floor;
      const logs = await guarded(() =>
        client.getLogs({
          address: market,
          event: announced,
          args: tokenFilter === undefined ? undefined : { tokenId: tokenFilter },
          fromBlock: start,
          toBlock: end,
        }),
      );
      // newest first within the window
      for (const log of [...logs].reverse()) {
        if (out.length >= limit || scanned >= maxScan) break;
        const a = log.args as { hash?: Hex; listing?: Listing; signature?: Hex } | undefined;
        if (!a?.hash || !a.listing || a.signature === undefined || log.blockNumber === null) continue;
        if (seen.has(a.hash)) continue;
        seen.add(a.hash);
        scanned++;
        const state = await check(a.listing, a.signature);
        if (o.onlyOpen && state !== "Ok") continue;
        const p = pricing(a.listing, now);
        out.push({
          hash: a.hash,
          listing: a.listing,
          signature: a.signature,
          state,
          open: state === "Ok",
          dutch: isDutch(a.listing),
          priceNow: p.price,
          feeNow: p.fee,
          sellerReceives: p.sellerReceives,
          announcedAtBlock: log.blockNumber,
          announcedTx: log.transactionHash as Hex,
        });
      }
    }
    return out;
  }

  /**
   * Prices one listing now and works out the bounds a careful buyer would sign up to, from what the
   * position looks like at this moment. Reads only, nothing is sent.
   */
  async function quote(listing: Listing, signature: Hex): Promise<Quote> {
    const hash = await guarded(() => client.readContract({ address: market, abi: marketAbi, functionName: "hashListing", args: [tupleOf(listing)] }));
    const [state, at] = await Promise.all([check(listing, signature), chainNow()]);
    const p = pricing(listing, at);
    const q: Quote = { hash, state, open: state === "Ok", at, price: p.price, fee: p.fee, sellerReceives: p.sellerReceives };
    if (p.price === null) return q;

    let position: PositionView | undefined;
    try {
      position = await lens.position(listing.tokenId);
    } catch {
      return q;
    }
    q.position = position;
    const vault = await vaultOf(ctx, listing.tokenId);
    const [epoch, reserveBtc, reserveMusd] = await Promise.all([
      guarded(() => client.readContract({ address: deployment.trozu.nft, abi: nftAbi, functionName: "transferEpoch", args: [listing.tokenId] })),
      guarded(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "reserveBtc" })),
      guarded(() => client.readContract({ address: vault, abi: vaultAbi, functionName: "reserveMusd" })),
    ]);
    q.bounds = defaultBounds(
      { epoch, coll: position.collateral, debt: position.debt, rateBps: position.lockedRateBps, reserveBtc, reserveMusd },
      p.price,
    );
    return q;
  }

  return { listings, quote, check };
}

export type MarketReads = ReturnType<typeof marketReads>;
