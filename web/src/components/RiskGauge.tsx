"use client";

import { useEffect, useRef } from "react";
import { CountUp } from "./CountUp";
import { GAUGE_MAX, GAUGE_MIN, gaugeFraction, type RiskInfo } from "@/lib/risk";
import { sweepArc } from "@/lib/motion";

const R = 80;
const LENGTH = Math.PI * R;
const percent = (n: number) => `${n.toFixed(1)}%`;

// a short radial mark on the arc for a collateral ratio, used for the 110% and 150% lines
function tick(ratio: number, inner: number, outer: number) {
  const theta = Math.PI * (1 - gaugeFraction(ratio));
  const p = (r: number) => `${100 + r * Math.cos(theta)} ${100 - r * Math.sin(theta)}`;
  return `M ${p(inner)} L ${p(outer)}`;
}

export function RiskGauge({ icrRatio, risk, noDebt }: { icrRatio: number; risk: RiskInfo; noDebt: boolean }) {
  const arc = useRef<SVGPathElement>(null);
  const last = useRef(0);
  const fraction = risk.level === "none" ? 0 : gaugeFraction(noDebt ? Infinity : icrRatio);

  useEffect(() => {
    if (arc.current) sweepArc(arc.current, LENGTH, last.current, fraction);
    last.current = fraction;
  }, [fraction]);

  const d = `M ${100 - R} 100 A ${R} ${R} 0 0 1 ${100 + R} 100`;
  return (
    <div className={`gauge risk-${risk.level}`}>
      <svg
        viewBox="0 0 200 118"
        role="img"
        aria-label={`Collateral ratio ${noDebt ? "no debt" : percent(icrRatio * 100)}, ${risk.label}`}
      >
        <path className="gauge-track" d={d} />
        <path ref={arc} className="gauge-value" d={d} />
        <path className="gauge-tick" d={tick(1.1, R - 12, R + 8)} />
        <path className="gauge-tick" d={tick(1.5, R - 12, R + 8)} />
      </svg>
      <div className="gauge-read">
        {risk.level === "none" ? (
          <span className="gauge-num">—</span>
        ) : noDebt ? (
          <span className="gauge-num">∞</span>
        ) : (
          <CountUp className="gauge-num" value={icrRatio * 100} format={percent} />
        )}
        <span className="gauge-label">{risk.label}</span>
      </div>
      <div className="gauge-scale" aria-hidden>
        <span>{(GAUGE_MIN * 100).toFixed(0)}%</span>
        <span className="mcr">marks: 110% and 150%</span>
        <span>{(GAUGE_MAX * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
}
