import { formatUnits } from "viem";

const WAD = 10n ** 18n;

/** Whole-number grouping for the integer part, fixed decimals after it. */
function group(value: string): string {
  const [int, frac] = value.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/** Truncates (never rounds up) a 1e18 amount to `digits` decimals. */
export function fixed(amount: bigint, digits: number): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(18 - digits);
  const cut = abs / scale;
  const s = formatUnits(cut, digits);
  const [int, frac = ""] = s.split(".");
  const padded = digits === 0 ? int : `${int}.${frac.padEnd(digits, "0")}`;
  return (negative && cut !== 0n ? "-" : "") + group(padded);
}

export const formatBtc = (wei: bigint) => fixed(wei, 5);
export const formatMusd = (wei: bigint) => fixed(wei, 2);

/** ICR is a 1e18 ratio, 1.6e18 is 160%. The "no debt" sentinel is max uint256. */
export function formatIcr(icr: bigint): string {
  if (icr >= 2n ** 200n) return "no debt";
  return `${fixed(icr * 100n, 1)}%`;
}

/** Basis points as a percentage, 100 -> "1.00%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatSignedBps(bps: number): string {
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  return `${sign}${(Math.abs(bps) / 100).toFixed(2)} pts`;
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Number form of a 1e18 amount for animation targets. Precision loss is fine for display. */
export function toNumber(wei: bigint, decimals = 18): number {
  return Number(formatUnits(wei, decimals));
}

export { WAD };
