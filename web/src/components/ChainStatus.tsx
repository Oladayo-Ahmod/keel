"use client";

import { useChainHead } from "@/hooks/useChain";

/** Latest block seen and whether the node answering looks current. */
export function ChainStatus() {
  const { freshness, error } = useChainHead();
  if (error && !freshness) {
    return (
      <span className="status-pill down" role="status">
        <i aria-hidden /> RPC unreachable
      </span>
    );
  }
  if (!freshness) {
    return (
      <span className="status-pill" role="status">
        <i aria-hidden /> Checking the chain…
      </span>
    );
  }
  if (freshness.stale) {
    return (
      <span className="status-pill warn" role="status" title={freshness.reason}>
        <i aria-hidden /> Node behind, data may be stale
      </span>
    );
  }
  return (
    <span className="status-pill" role="status" title={`Latest block ${freshness.blockNumber.toString()}`}>
      <i aria-hidden /> Block {freshness.blockNumber.toLocaleString("en-US")}
    </span>
  );
}
