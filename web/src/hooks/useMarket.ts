"use client";

import { useQuery } from "@tanstack/react-query";
import type { PublicClient } from "viem";
import { positionLensAbi } from "@/abi/keel";
import { trozuMarketAbi, trozuVaultAbi } from "@/abi/trozu";
import { LOG_WINDOW, wave2 } from "@/config/wave2";
import type { Freshness } from "@/lib/freshness";
import { stateName, type Listing, type MarketState } from "@/lib/market";
import { freshRead } from "@/lib/rpc";
import type { PositionInfo } from "./usePositions";

type Hex = `0x${string}`;

export interface MarketRow {
  hash: Hex;
  listing: Listing;
  signature: Hex;
  /** What `check` says right now: Ok, or the reason it cannot settle. */
  state: MarketState;
  info: PositionInfo | undefined;
  reserveBtc: bigint;
  reserveMusd: bigint;
}

export interface MarketData {
  rows: MarketRow[];
  feeBps: number;
  freshness: Freshness;
  scannedTo: bigint;
  /** Blocks of logs read from the chain, for the caption under the list. */
  fromBlock: bigint;
}

const announced = trozuMarketAbi.find((x) => x.type === "event" && x.name === "ListingAnnounced")!;

interface Found {
  hash: Hex;
  listing: Listing;
  signature: Hex;
}

// Logs already read this session. A scan resumes after the last block it finished, so a refresh
// reads a few new blocks and not the whole history again.
const seen = { to: wave2.deployBlock - 1n, found: new Map<Hex, Found>() };

async function scan(c: PublicClient, head: bigint): Promise<void> {
  for (let from = seen.to + 1n; from <= head; from += LOG_WINDOW) {
    const to = from + LOG_WINDOW - 1n > head ? head : from + LOG_WINDOW - 1n;
    const logs = await c.getLogs({ address: wave2.market, event: announced as never, fromBlock: from, toBlock: to });
    for (const log of logs) {
      const a = (log as unknown as { args: { hash: Hex; listing: Listing; signature: Hex } }).args;
      seen.found.set(a.hash, { hash: a.hash, listing: a.listing, signature: a.signature });
    }
    seen.to = to;
  }
}

/** Read every announced listing, ask the market whether each can settle, and attach the position it is for. */
export async function loadMarket(): Promise<MarketData> {
  const r = await freshRead(async (c) => {
    const head = await c.getBlockNumber();
    await scan(c, head);
    const feeBps = await c.readContract({ address: wave2.market, abi: trozuMarketAbi, functionName: "FEE_BPS" });
    const found = [...seen.found.values()];
    const rows = await Promise.all(
      found.map(async (f): Promise<MarketRow> => {
        const [state, info] = await Promise.all([
          c.readContract({ address: wave2.market, abi: trozuMarketAbi, functionName: "check", args: [f.listing, f.signature] }),
          c
            .readContract({ address: wave2.lens, abi: positionLensAbi, functionName: "positionInfo", args: [f.listing.tokenId] })
            .then((x) => x as unknown as PositionInfo)
            .catch(() => undefined),
        ]);
        let reserveBtc = 0n;
        let reserveMusd = 0n;
        if (info) {
          [reserveBtc, reserveMusd] = await Promise.all([
            c.readContract({ address: info.vault, abi: trozuVaultAbi, functionName: "reserveBtc" }),
            c.readContract({ address: info.vault, abi: trozuVaultAbi, functionName: "reserveMusd" }),
          ]).catch(() => [0n, 0n] as const);
        }
        return { hash: f.hash, listing: f.listing, signature: f.signature, state: stateName(state as number), info, reserveBtc, reserveMusd };
      }),
    );
    return { rows, feeBps: Number(feeBps), scannedTo: head };
  });
  return { ...r.data, freshness: r.freshness, fromBlock: wave2.deployBlock };
}

export function useMarket() {
  return useQuery({
    queryKey: ["market", wave2.market],
    queryFn: loadMarket,
    enabled: wave2.enabled,
    refetchInterval: 30_000,
    retry: 1,
  });
}
