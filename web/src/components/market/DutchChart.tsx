"use client";

import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { formatMusd } from "@/lib/format";
import { isDutch, priceAt, priceCurve, type Listing } from "@/lib/market";
import { prefersReducedMotion } from "@/lib/motion";

const W = 320;
const H = 140;
const PAD = { l: 8, r: 8, t: 12, b: 22 };

const hours = (s: bigint) => {
  const h = Number(s) / 3600;
  return h >= 48 ? `${(h / 24).toFixed(1)} days` : h >= 1 ? `${h.toFixed(1)} hours` : `${Math.round(Number(s) / 60)} minutes`;
};

/** Price against time for a listing, with the price right now marked. A fixed price is a flat line. */
export function DutchChart({ listing, nowSeconds }: { listing: Listing; nowSeconds: bigint }) {
  const line = useRef<SVGPathElement>(null);
  const curve = priceCurve(listing, 64);
  const hi = Number(listing.startPrice);
  const lo = Number(listing.endPrice);
  const span = Math.max(hi - lo, hi * 0.02, 1);
  const t0 = Number(listing.startTime);
  const t1 = Number(listing.deadline);
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(t1 - t0, 1)) * (W - PAD.l - PAD.r);
  // a flat fixed price sits in the middle band so it still reads as a line
  const y = (p: number) => (hi === lo ? H / 2 - 6 : PAD.t + ((hi - p) / span) * (H - PAD.t - PAD.b));
  const d = curve.map((c, i) => `${i ? "L" : "M"} ${x(c.t).toFixed(1)} ${y(Number(c.price)).toFixed(1)}`).join(" ");

  const now = nowSeconds < listing.startTime ? listing.startTime : nowSeconds > listing.deadline ? listing.deadline : nowSeconds;
  const priceNow = priceAt(listing, nowSeconds);
  const nx = x(Number(now));
  const ny = y(Number(priceNow));
  const dutch = isDutch(listing);

  useEffect(() => {
    const el = line.current;
    if (!el || prefersReducedMotion()) return;
    const len = el.getTotalLength();
    el.style.strokeDasharray = `${len}`;
    animate(el, { strokeDashoffset: [len, 0], duration: 900, ease: "outQuad" });
  }, [d]);

  const summary = dutch
    ? `Falls from ${formatMusd(listing.startPrice)} to ${formatMusd(listing.endPrice)} MUSD over ${hours(listing.endTime - listing.startTime)}, then holds until it expires. Now ${formatMusd(priceNow)} MUSD.`
    : `Fixed price of ${formatMusd(listing.startPrice)} MUSD until it expires.`;

  return (
    <figure className="dutch">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet">
        <line className="dutch-axis" x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} />
        {dutch && <line className="dutch-floor" x1={PAD.l} y1={y(lo)} x2={W - PAD.r} y2={y(lo)} />}
        <path ref={line} className="dutch-line" d={d} />
        <line className="dutch-now" x1={nx} y1={PAD.t - 4} x2={nx} y2={H - PAD.b} />
        <circle className="dutch-dot" cx={nx} cy={ny} r={5} />
        <text className="dutch-label" x={PAD.l} y={H - 6}>start</text>
        <text className="dutch-label" x={W - PAD.r} y={H - 6} textAnchor="end">expires</text>
      </svg>
      <figcaption>{summary}</figcaption>
    </figure>
  );
}
