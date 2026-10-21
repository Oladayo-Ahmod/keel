"use client";

import { formatBps, formatMusd } from "@/lib/format";

/** Locked rate against the current global rate, with what the gap is worth. */
export function RateCompare({
  locked,
  global,
  spreadBps,
  annualSpread,
}: {
  locked: number;
  global: number;
  spreadBps: number;
  annualSpread: bigint;
}) {
  const max = Math.max(locked, global, 1);
  const cheaper = spreadBps > 0;
  const dearer = spreadBps < 0;
  const gap = `${(Math.abs(spreadBps) / 100).toFixed(2)} points`;
  return (
    <section className="block" aria-label="Interest rate">
      <h4>Interest rate</h4>
      <div className="rate-row">
        <span className="rate-name">Locked</span>
        <div className="bar">
          <i style={{ width: `${(locked / max) * 100}%` }} />
        </div>
        <span className="mono">{formatBps(locked)}</span>
      </div>
      <div className="rate-row">
        <span className="rate-name">Market</span>
        <div className="bar bar-market">
          <i style={{ width: `${(global / max) * 100}%` }} />
        </div>
        <span className="mono">{formatBps(global)}</span>
      </div>
      <p className={`note ${cheaper ? "good" : dearer ? "warn" : ""}`}>
        {cheaper && (
          <>
            Locked {gap} below the market. Worth about <b className="mono">{formatMusd(annualSpread)} MUSD</b> a year at
            today&apos;s rate, and it goes with the NFT.
          </>
        )}
        {dearer && <>Locked {gap} above the market. Refinancing would lower it, for a small fee.</>}
        {!cheaper && !dearer && <>Locked rate equals the market rate. No premium to carry.</>}
      </p>
    </section>
  );
}
