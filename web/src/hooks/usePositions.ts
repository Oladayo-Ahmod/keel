"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { positionLensAbi } from "@/abi/keel";
import { config } from "@/config";

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
  | { status: "ready"; positions: PositionInfo[]; refresh: () => void };

const lens = config.keel.lens;

// ERC721NonexistentToken(uint256), by name or by its selector when the ABI does not know it
const NONEXISTENT = /ERC721NonexistentToken|0x7e273289/;

function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0].slice(0, 200);
}

/** Positions held by an address, read from the lens. */
export function usePositionsOf(holder: `0x${string}` | undefined): PositionsState {
  const ids = useReadContract({
    address: lens,
    abi: positionLensAbi,
    functionName: "positionsOf",
    args: holder ? [holder] : undefined,
    query: { enabled: !!holder, refetchInterval: 20_000 },
  });
  return useInfos(ids.data as readonly bigint[] | undefined, ids.isLoading, ids.error, ids.refetch, !!holder);
}

/** One position by NFT id, for lookups without a wallet. */
export function usePositionById(id: bigint | undefined): PositionsState {
  const ids = useMemo(() => (id === undefined ? undefined : ([id] as readonly bigint[])), [id]);
  return useInfos(ids, false, null, () => undefined, id !== undefined);
}

function useInfos(
  ids: readonly bigint[] | undefined,
  idsLoading: boolean,
  idsError: unknown,
  refetchIds: () => unknown,
  enabled: boolean,
): PositionsState {
  const infos = useReadContracts({
    contracts: (ids ?? []).map((id) => ({
      address: lens,
      abi: positionLensAbi,
      functionName: "positionInfo" as const,
      args: [id] as const,
    })),
    query: { enabled: !!ids && ids.length > 0, refetchInterval: 20_000 },
  });

  if (!enabled) return { status: "idle" };
  if (idsError) return { status: "error", message: describe(idsError), retry: () => void refetchIds() };
  if (idsLoading || (ids && ids.length > 0 && infos.isLoading)) return { status: "loading" };
  if (infos.error) return { status: "error", message: describe(infos.error), retry: () => void infos.refetch() };
  if (!ids) return { status: "loading" };

  const positions: PositionInfo[] = [];
  const failed: string[] = [];
  let missingCount = 0;
  (infos.data ?? []).forEach((r, i) => {
    if (r.status === "success") positions.push(r.result as unknown as PositionInfo);
    else {
      failed.push(`#${ids[i]}: ${describe(r.error)}`);
      if (NONEXISTENT.test(String((r.error as Error | undefined)?.message ?? r.error))) missingCount++;
    }
  });
  // an id that was never minted makes the lens revert inside ownerOf; that is "not found", not a fault
  const missing = failed.length > 0 && missingCount === failed.length;
  if (missing) {
    return { status: "ready", positions: [], refresh: () => void infos.refetch() };
  }
  if (failed.length && !positions.length) {
    return { status: "error", message: failed[0], retry: () => void infos.refetch() };
  }
  return {
    status: "ready",
    positions,
    refresh: () => {
      void refetchIds();
      void infos.refetch();
    },
  };
}
