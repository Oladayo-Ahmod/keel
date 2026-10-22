/** Collateral ratio levels, as 1e18 ratios. MCR is where Mezo liquidates. */
export const MCR = 11n * 10n ** 17n; // 110%
export const CAUTION = 125n * 10n ** 16n; // 125%
export const SAFE = 15n * 10n ** 17n; // 150%, also Mezo's Recovery Mode threshold

export type Risk = "safe" | "caution" | "danger" | "none" | "stale";

export interface RiskInfo {
  level: Risk;
  label: string;
  hint: string;
}

export function riskOf(icr: bigint, active: boolean, stale = false): RiskInfo {
  // numbers from a lagging node must never read as healthy
  if (stale) return { level: "stale", label: "Stale data", hint: "The node that answered is behind. Do not rely on these numbers." };
  if (!active) return { level: "none", label: "No open trove", hint: "This position has no trove right now." };
  if (icr >= 2n ** 200n) return { level: "safe", label: "No debt", hint: "Nothing to liquidate." };
  if (icr >= SAFE) return { level: "safe", label: "Healthy", hint: "Comfortably above the 110% liquidation line." };
  if (icr >= CAUTION) return { level: "caution", label: "Watch", hint: "A moderate price drop gets this near liquidation." };
  if (icr >= MCR) return { level: "danger", label: "At risk", hint: "Close to the 110% liquidation line." };
  return { level: "danger", label: "Liquidatable", hint: "Below 110%. Anyone can liquidate this trove." };
}

/** Gauge runs from 100% to 250%. Returns 0..1. */
export const GAUGE_MIN = 1.0;
export const GAUGE_MAX = 2.5;

export function gaugeFraction(icrRatio: number): number {
  if (!Number.isFinite(icrRatio)) return 1;
  return Math.min(1, Math.max(0, (icrRatio - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)));
}
