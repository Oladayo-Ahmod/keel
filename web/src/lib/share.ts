import { formatBps, formatBtc, formatIcr, formatMusd } from "./format";
import { riskOf, type Risk } from "./risk";
import type { Proof } from "./content";

export type Wave = "1" | "2";

/** The wave in a link: "1" or "2". Anything else is not a position link. */
export const parseWave = (s: string): Wave | undefined => (s === "1" || s === "2" ? s : undefined);

/** A token id from a link: plain digits, no sign, no leading zeros, small enough to be a real id. */
export function parseTokenId(s: string): bigint | undefined {
  if (!/^(0|[1-9]\d{0,17})$/.test(s)) return undefined;
  return BigInt(s);
}

/** The only fields of a position a card reads. All of them are public on-chain values; the holder is left out on purpose. */
export interface CardSource {
  tokenId: bigint;
  vault: `0x${string}`;
  active: boolean;
  priceOk: boolean;
  coll: bigint;
  debt: bigint;
  icr: bigint;
  lockedRateBps: number;
  globalRateBps: number;
}

export interface CardStat {
  label: string;
  value: string;
}

export interface Card {
  kind: "position" | "proof" | "unavailable" | "missing";
  title: string;
  /** Short line under the title. */
  subtitle: string;
  chip?: { text: string; level: Risk };
  stats: CardStat[];
  foot: string;
}

const NET = "Mezo testnet";
const FOOT = "Public on-chain values only. Testnet only. Not audited.";
const FOOT_PROOF = "Figures from the project's own proof file. Testnet only. Not audited.";

/** The share card for one position, from numbers the lens returned. `stale` means the answering node was behind. */
export function positionCard(p: CardSource, wave: Wave, stale: boolean): Card {
  const title = `Position #${p.tokenId.toString()}`;
  const risk = riskOf(p.icr, p.active, stale);
  const ratio = stale ? "unverified" : p.priceOk ? formatIcr(p.icr) : "price feed down";
  const spread = p.globalRateBps - p.lockedRateBps;
  return {
    kind: "position",
    title,
    subtitle: `${NET} · ${wave === "2" ? "market-ready position" : "position"} · vault ${p.vault.slice(0, 6)}…${p.vault.slice(-4)}`,
    chip: { text: p.priceOk || stale ? risk.label : "No price", level: p.priceOk || stale ? risk.level : "none" },
    stats: [
      { label: "Collateral ratio", value: ratio },
      { label: "Collateral", value: `${formatBtc(p.coll)} BTC` },
      { label: "Debt", value: `${formatMusd(p.debt)} MUSD` },
      {
        label: "Locked rate",
        value: `${formatBps(p.lockedRateBps)}${spread > 0 ? ` vs ${formatBps(p.globalRateBps)} market` : ""}`,
      },
    ],
    foot: FOOT,
  };
}

/** Shown when the chain cannot be read right now. It names no numbers. */
export function unavailableCard(id: bigint | undefined): Card {
  return {
    kind: "unavailable",
    title: id === undefined ? "Trozu position" : `Position #${id.toString()}`,
    subtitle: `${NET} · live numbers are not available right now`,
    stats: [],
    foot: FOOT,
  };
}

export function missingCard(id: bigint): Card {
  return { kind: "missing", title: `Position #${id.toString()}`, subtitle: `${NET} · no position with this id`, stats: [], foot: FOOT };
}

/** The proof page card: counts taken from the proof file, never typed here. A file that failed its checks gives a plain card. */
export function proofCard(r: { ok: true; data: Proof } | { ok: false }): Card {
  if (!r.ok) {
    return { kind: "proof", title: "Trozu proof", subtitle: "Each claim, how it was checked, and the evidence.", stats: [], foot: FOOT_PROOF };
  }
  const d = r.data;
  const verified = d.claims.filter((c) => c.status === "verified").length;
  const stats: CardStat[] = [];
  const n = (v: number | null) => (v === null ? "not recorded" : v.toLocaleString("en-US"));
  stats.push({ label: "Tests passing", value: d.summary.passing === null ? "not recorded" : `${n(d.summary.passing)} of ${n(d.summary.tests)}` });
  stats.push({ label: "Claims verified", value: d.claims.length ? `${verified} of ${d.claims.length}` : "none listed" });
  stats.push({ label: "Deployments", value: d.deployments.length ? `${d.deployments.filter((x) => x.verification === "exact").length} of ${d.deployments.length} source matched` : "none listed" });
  return {
    kind: "proof",
    title: "Trozu proof",
    subtitle: `${NET} · each claim, how it was checked, and the evidence`,
    stats,
    foot: FOOT_PROOF,
  };
}

/** Absolute base for share links. Set NEXT_PUBLIC_SITE_URL in production; on Vercel the project's own domain is used. */
export function siteUrl(env: Record<string, string | undefined> = process.env): URL {
  const explicit = env.NEXT_PUBLIC_SITE_URL;
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL;
  const raw = explicit || (vercel ? `https://${vercel}` : "http://localhost:3000");
  try {
    return new URL(raw);
  } catch {
    return new URL("http://localhost:3000");
  }
}
