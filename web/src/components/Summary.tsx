"use client";

import { toNumber } from "@/lib/format";
import type { PositionInfo } from "@/hooks/usePositions";
import { CountUp } from "./CountUp";

const btc = (n: number) => n.toFixed(5);
const musd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (n: number) => Math.round(n).toString();

export function Summary({ positions }: { positions: PositionInfo[] }) {
  const active = positions.filter((p) => p.active);
  const coll = active.reduce((a, p) => a + p.coll, 0n);
  const debt = active.reduce((a, p) => a + p.debt, 0n);
  return (
    <section className="glass summary" aria-label="Totals">
      <div>
        <span className="label">Positions</span>
        <CountUp className="big mono" value={positions.length} format={whole} />
      </div>
      <div>
        <span className="label">Collateral</span>
        <span className="big">
          <CountUp className="mono" value={toNumber(coll)} format={btc} /> <small>BTC</small>
        </span>
      </div>
      <div>
        <span className="label">Debt</span>
        <span className="big">
          <CountUp className="mono" value={toNumber(debt)} format={musd} /> <small>MUSD</small>
        </span>
      </div>
    </section>
  );
}
