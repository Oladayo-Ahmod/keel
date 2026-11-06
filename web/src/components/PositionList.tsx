"use client";

import { useEffect, useRef } from "react";
import { enterStaggered } from "@/lib/motion";
import type { PositionInfo, PositionsState } from "@/hooks/usePositions";
import { EmptyState, ErrorState, Skeleton } from "./States";
import { PositionCard } from "./PositionCard";
import { Summary } from "./Summary";

/** Renders every state of a positions query: idle, loading, error, empty and ready. */
export function PositionList({
  state,
  viewer,
  idle,
  empty,
  nft,
  v2 = false,
  extra,
}: {
  state: PositionsState;
  viewer?: `0x${string}`;
  idle: React.ReactNode;
  empty: React.ReactNode;
  nft?: `0x${string}`;
  v2?: boolean;
  /** Sections shown under the manage panel of each card, such as sell and guardian. */
  extra?: (p: PositionInfo) => React.ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const seen = useRef<string>("");
  const ready = state.status === "ready" ? state.positions : null;
  const key = ready ? ready.map((p) => p.tokenId.toString()).join(",") : "";

  // cards slide in when the set of positions changes, not on every refresh
  useEffect(() => {
    if (!grid.current || !ready || key === seen.current) return;
    seen.current = key;
    enterStaggered(grid.current.querySelectorAll(".pos-card"));
  }, [key, ready]);

  if (state.status === "idle") return <>{idle}</>;
  if (state.status === "loading")
    return (
      <div className="grid" aria-busy="true" aria-label="Loading positions">
        <Skeleton height={420} />
        <Skeleton height={420} />
      </div>
    );
  if (state.status === "error") return <ErrorState message={state.message} onRetry={state.retry} />;
  if (state.positions.length === 0) return <>{empty}</>;

  const stale = state.freshness.stale;
  return (
    <>
      {stale && (
        <div className="banner warn" role="alert">
          <span>
            Could not reach an up-to-date node. {state.freshness.reason} Positions below are shown as unverified and
            actions are disabled.
          </span>
          <button className="btn btn-small" onClick={state.refresh}>
            Try again
          </button>
        </div>
      )}
      <Summary positions={state.positions} />
      <div className="grid" ref={grid}>
        {state.positions.map((p: PositionInfo) => (
          <PositionCard key={p.tokenId.toString()} p={p} viewer={viewer} onChanged={state.refresh} stale={stale} nft={nft} v2={v2} extra={extra?.(p)} />
        ))}
      </div>
    </>
  );
}
