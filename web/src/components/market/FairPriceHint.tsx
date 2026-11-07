"use client";

import { useEffect, useMemo, useRef } from "react";
import { useGuardian } from "@/hooks/useGuardian";
import type { PositionInfo } from "@/hooks/usePositions";
import { fairPrice } from "@/lib/fairprice";
import { formatBps, formatMusd } from "@/lib/format";
import { revealIn } from "@/lib/motion";

/**
 * A starting point for the asking price, built from the position's own numbers and shown with every input
 * so the seller can disagree with any of them. It never fills a field by itself.
 */
export function FairPriceHint({
  p,
  kind,
  stale,
  onUse,
}: {
  p: PositionInfo;
  kind: "fixed" | "dutch";
  stale: boolean;
  onUse: (start: bigint, end?: bigint) => void;
}) {
  const guardian = useGuardian(p.vault, p.tokenId);
  const g = guardian.data?.data;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => revealIn(ref.current), []);

  const est = useMemo(
    () =>
      fairPrice({
        active: p.active,
        priceOk: p.priceOk,
        equity: p.equity,
        principal: p.principal,
        lockedRateBps: p.lockedRateBps,
        globalRateBps: p.globalRateBps,
        reserveBtc: g?.reserveBtc,
        reserveMusd: g?.reserveMusd,
        btcPrice: p.price,
      }),
    [p, g],
  );

  const hasReserve = !!g && (g.reserveBtc > 0n || g.reserveMusd > 0n);

  return (
    <aside ref={ref} className="hint" aria-label="Price estimate">
      <header className="hint-head">
        <h5>Price estimate</h5>
        <span className="chip chip-none">Estimate</span>
      </header>
      {!est.available || stale ? (
        <p className="note">{stale ? "The node is behind the chain, so no estimate is shown." : est.reason}</p>
      ) : (
        <>
          <dl className="hint-inputs">
            <div><dt>Equity</dt><dd className="mono">{formatMusd(est.equity)} MUSD</dd></div>
            {hasReserve && <div><dt>Guardian reserve</dt><dd className="mono">{formatMusd(est.reserveValue)} MUSD</dd></div>}
            <div><dt>Locked rate</dt><dd className="mono">{formatBps(p.lockedRateBps)}</dd></div>
            <div><dt>Market rate</dt><dd className="mono">{formatBps(p.globalRateBps)}</dd></div>
            <div><dt>Principal</dt><dd className="mono">{formatMusd(p.principal)} MUSD</dd></div>
            <div>
              <dt>Rate advantage a year</dt>
              <dd className="mono">{est.hasPremium ? `${formatMusd(est.yearlyValue)} MUSD` : "none"}</dd>
            </div>
            <div><dt>Horizon</dt><dd className="mono">{est.years} year</dd></div>
          </dl>
          <p className="hint-result">
            <span>Suggested {kind === "dutch" && est.dutch ? "start" : "price"}</span>
            <b className="mono big">{formatMusd(kind === "dutch" && est.dutch ? est.dutch.start : est.suggested)} MUSD</b>
          </p>
          {kind === "dutch" && est.dutch && (
            <p className="note">Falling to <b className="mono">{formatMusd(est.dutch.end)} MUSD</b>, the value with no rate premium.</p>
          )}
          {kind === "dutch" && !est.dutch && <p className="note">There is no premium to fall through, so an auction has no range here. Use a fixed price.</p>}
          <p className="note">
            {est.note} Equity is collateral value minus debt, read from the chain. This is an estimate. It is not a
            valuation, and nobody has to pay it.
          </p>
          <button
            type="button"
            className="btn btn-quiet btn-small"
            disabled={kind === "dutch" && !est.dutch}
            onClick={() => (kind === "dutch" && est.dutch ? onUse(est.dutch.start, est.dutch.end) : onUse(est.suggested))}
          >
            Use as {kind === "dutch" ? "start and lowest price" : "price"}
          </button>
        </>
      )}
    </aside>
  );
}
