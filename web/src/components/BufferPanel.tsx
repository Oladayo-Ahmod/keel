"use client";

import { useState } from "react";
import { useReadContract } from "wagmi";
import { positionLensAbi } from "@/abi/keel";
import { config } from "@/config";
import { formatMusd } from "@/lib/format";
import { pressPulse } from "@/lib/motion";

const MAX_STEPS = 100n;

interface Buffer {
  buffer: bigint;
  eligibleAhead: bigint;
  steps: bigint;
  complete: boolean;
  inList: boolean;
}

/**
 * How much MUSD has to be redeemed before this trove is reached. It walks the
 * redemption queue on chain, so it only runs when asked.
 */
export function BufferPanel({ tokenId, active }: { tokenId: bigint; active: boolean }) {
  const [asked, setAsked] = useState(false);
  const q = useReadContract({
    address: config.keel.lens,
    abi: positionLensAbi,
    functionName: "redemptionBuffer",
    args: [tokenId, MAX_STEPS],
    query: { enabled: asked && active },
  });
  const b = q.data as Buffer | undefined;

  return (
    <section className="block" aria-label="Redemption buffer">
      <h4>Redemption buffer</h4>
      {!active && <p className="note">No trove, so nothing can be redeemed.</p>}
      {active && !asked && (
        <>
          <p className="note">
            Redeemers take collateral from the lowest-ratio troves first. This shows how much MUSD must be redeemed before
            this one is reached.
          </p>
          <button
            className="btn btn-quiet"
            onClick={(e) => {
              pressPulse(e.currentTarget);
              setAsked(true);
            }}
          >
            Check buffer
          </button>
        </>
      )}
      {active && asked && q.isLoading && <div className="skeleton line" aria-label="Checking the redemption queue" />}
      {active && asked && q.error && (
        <p className="note warn" role="alert">
          The queue check failed.{" "}
          <button className="link" onClick={() => q.refetch()}>
            Retry
          </button>
        </p>
      )}
      {b && !b.inList && <p className="note">This trove is not in the redemption queue.</p>}
      {b && b.inList && b.complete && (
        <p className="buffer-read">
          <span className="mono big">{formatMusd(b.buffer)}</span> MUSD
          <span className="note">
            ahead of this position, across {b.eligibleAhead.toString()} trove{b.eligibleAhead === 1n ? "" : "s"}. Exact for
            this block; it moves as others change.
          </span>
        </p>
      )}
      {b && b.inList && !b.complete && (
        <p className="buffer-read">
          <span className="mono big">≥ {formatMusd(b.buffer)}</span> MUSD
          <span className="note">
            Only the first {b.steps.toString()} troves were checked, so this is a lower bound. The real buffer is at least
            this large, not necessarily close to it.
          </span>
        </p>
      )}
    </section>
  );
}
