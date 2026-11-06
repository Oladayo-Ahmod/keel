"use client";

import { useQuery } from "@tanstack/react-query";
import { positionLensAbi } from "@/abi/keel";
import { config } from "@/config";
import type { Freshness } from "@/lib/freshness";
import { freshRead, worst } from "@/lib/rpc";

export interface PositionInfo {
  tokenId: bigint;
  vault: `0x${string}`;
  holder: `0x${string}`;
  active: boolean;
  coll: bigint;
  principal: bigint;
  interest: bigint;
  debt: bigint;
  priceOk: boolean;
  price: bigint;
  icr: bigint;
  equity: bigint;
  lockedRateBps: number;
  globalRateBps: number;
  spreadBps: bigint;
  annualSpreadMusd: bigint;
  claimableSurplus: bigint;
  refinanceFeeEstimate: bigint;
  redeemable: boolean;
  recoveryMode: boolean;
  canClose: boolean;
}

export type PositionsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; retry: () => void }
  | { status: "ready"; positions: PositionInfo[]; refresh: () => void; freshness: Freshness };

const MAX_POSITIONS = 50;

// ERC721NonexistentToken(uint256), by name or by its selector when the ABI does not know it
const NONEXISTENT = /ERC721NonexistentToken|0x7e273289/;

function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0].slice(0, 200);
}

interface Loaded {
  positions: PositionInfo[];
  freshness: Freshness;
}

/**
 * Two steps, the id list and then one lens call per id, each paired with the head of the node
 * that answered. If either answer cannot be shown to be current the result says so.
 */
async function load(lens: `0x${string}`, holder: `0x${string}` | undefined, fixedId: bigint | undefined): Promise<Loaded> {
  let ids: readonly bigint[];
  let idsFreshness: Freshness | undefined;
  if (fixedId !== undefined) {
    ids = [fixedId];
  } else {
    const r = await freshRead((c) =>
      c.readContract({ address: lens, abi: positionLensAbi, functionName: "positionsOf", args: [holder!] }),
    );
    ids = (r.data as readonly bigint[]).slice(0, MAX_POSITIONS);
    idsFreshness = r.freshness;
  }
  if (ids.length === 0 && idsFreshness) return { positions: [], freshness: idsFreshness };

  const r = await freshRead((c) =>
    Promise.allSettled(ids.map((id) => c.readContract({ address: lens, abi: positionLensAbi, functionName: "positionInfo", args: [id] }))),
  );
  const positions: PositionInfo[] = [];
  const failures: unknown[] = [];
  for (const res of r.data) {
    if (res.status === "fulfilled") positions.push(res.value as unknown as PositionInfo);
    else failures.push(res.reason);
  }
  const allMissing = failures.length > 0 && failures.every((f) => NONEXISTENT.test(String((f as Error)?.message ?? f)));
  if (failures.length && !positions.length && !allMissing) throw failures[0];
  return { positions, freshness: idsFreshness ? worst(idsFreshness, r.freshness) : r.freshness };
}

function toState(q: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: Loaded | undefined;
  refetch: () => unknown;
}): PositionsState {
  if (q.isPending) return { status: "loading" };
  if (q.isError || !q.data) return { status: "error", message: describe(q.error), retry: () => void q.refetch() };
  return { status: "ready", positions: q.data.positions, freshness: q.data.freshness, refresh: () => void q.refetch() };
}

/** Positions held by an address, read from the lens. */
export function usePositionsOf(holder: `0x${string}` | undefined, lens: `0x${string}` = config.keel.lens): PositionsState {
  const q = useQuery({
    queryKey: ["positions", lens, holder],
    queryFn: () => load(lens, holder, undefined),
    enabled: !!holder,
    refetchInterval: 20_000,
    retry: 1,
  });
  if (!holder) return { status: "idle" };
  return toState(q);
}

/** One position by NFT id, for lookups without a wallet. */
export function usePositionById(id: bigint | undefined, lens: `0x${string}` = config.keel.lens): PositionsState {
  const q = useQuery({
    queryKey: ["position", lens, id?.toString()],
    queryFn: () => load(lens, undefined, id),
    enabled: id !== undefined,
    refetchInterval: 20_000,
    retry: 1,
  });
  if (id === undefined) return { status: "idle" };
  return toState(q);
}
