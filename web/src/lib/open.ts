import { parseUnits } from "viem";
import { GAS_COMPENSATION } from "./hints";
import { formatBtc, formatMusd } from "./format";

const WAD = 10n ** 18n;

/** Below this the app refuses. Mezo's own floor is 110%, which would be liquidated by a tiny move. */
export const APP_MIN_ICR = 12n * 10n ** 17n; // 120%
export const SAFE_ICR = 15n * 10n ** 17n; // 150%
/** BTC kept back from the collateral so the wallet can still pay gas. */
export const GAS_RESERVE = 2n * 10n ** 15n; // 0.002 BTC

export interface OpenInputs {
  debt: bigint;
  coll: bigint;
  price: bigint;
  fee: bigint;
  minNetDebt: bigint;
  balance: bigint;
}

export interface OpenPlan {
  composite: bigint;
  icr: bigint;
  equity: bigint;
  errors: string[];
  warnings: string[];
}

/** Parses a decimal string into 1e18 units, or undefined if it is not a usable amount. */
export function parseAmount(text: string): bigint | undefined {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return undefined;
  try {
    const v = parseUnits(t, 18);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Collateral that gives `icr` (1e18 ratio) for a debt at a price, rounded up. */
export function collForIcr(debt: bigint, fee: bigint, price: bigint, icr: bigint): bigint {
  const composite = debt + fee + GAS_COMPENSATION;
  return (composite * icr + price - 1n) / price;
}

export function planOpen(i: OpenInputs): OpenPlan {
  const composite = i.debt + i.fee + GAS_COMPENSATION;
  const icr = i.price > 0n ? (i.coll * i.price) / composite : 0n;
  const equity = (i.coll * i.price) / WAD - composite;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (i.price === 0n) errors.push("The price feed did not answer, so the ratio cannot be checked.");
  if (i.debt + i.fee < i.minNetDebt) {
    errors.push(`Mezo's minimum is ${formatMusd(i.minNetDebt)} MUSD including the fee.`);
  }
  if (i.price > 0n && icr < APP_MIN_ICR) {
    errors.push("Collateral ratio must be at least 120%. Mezo liquidates at 110%.");
  } else if (i.price > 0n && icr < SAFE_ICR) {
    warnings.push("Under 150% a modest price drop gets this position liquidated. Mezo also needs the whole system above 150%.");
  }
  if (i.coll + GAS_RESERVE > i.balance) {
    errors.push(`Not enough BTC: this needs ${formatBtc(i.coll)} plus about ${formatBtc(GAS_RESERVE)} for gas.`);
  }
  return { composite, icr, equity, errors, warnings };
}
