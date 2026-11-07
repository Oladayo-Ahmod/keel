import { formatUnits } from "viem";

/** "1.2345" from wei, truncated and never rounded up, for sentences. */
export function formatAmount(wei: bigint, digits = 5): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const cut = abs / 10n ** BigInt(18 - digits);
  const s = formatUnits(cut, digits);
  return (neg && cut !== 0n ? "-" : "") + s;
}

/** Basis points as a percentage, 100 -> "1.00%". */
export const formatBps = (bps: number) => `${(bps / 100).toFixed(2)}%`;
