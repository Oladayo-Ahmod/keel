import { MAX_ATTEMPTS, assess, type Freshness, type Head, type Tracker } from "./freshness";
import { stateName } from "./market";
import { reasonName, kindName } from "./guardian";
import { scanStart, tally, windows, type OpenCandidate, type StatLog, type Tally } from "./stats";

type Hex = `0x${string}`;

/** What the snapshot needs from the chain. The server wires it to viem, the tests to a fake. */
export interface StatsChain {
  head(): Promise<Head>;
  /** Logs of all three sources for one window, with the head of the node that answered, read in one round trip. */
  window(from: bigint, to: bigint): Promise<{ nodeHead: bigint; factory: StatLog[]; market: StatLog[]; vaults: StatLog[] }>;
  /** `TrozuMarket.check`, the state index. */
  checkListing(c: OpenCandidate): Promise<number>;
  /** `TrozuVault.preview`, kind and reason indexes. */
  preview(vault: Hex): Promise<{ kind: number; reason: number }>;
}

/** Logs already read, so a later run only reads new blocks. Lives in server memory, never persisted. */
export interface ScanState {
  from: bigint;
  to: bigint;
  factory: StatLog[];
  market: StatLog[];
  vaults: StatLog[];
}

export interface SnapshotOptions {
  deployBlock: bigint;
  maxBlocks: bigint;
  windowSize: bigint;
  /** Stop reading new windows after this long and say the range is incomplete. */
  budgetMs: number;
  maxChecks: number;
  maxPreviews: number;
  /** The team's own wallets, lowercase or not. Listings from them are demo listings, and they are not counted as other people. */
  team?: Iterable<string>;
  tracker: Tracker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface StatsSnapshot {
  generatedAt: string;
  head: { block: string; timestamp: number; ageSeconds: number };
  /** The newest block the counts include. */
  asOfBlock: string;
  range: { fromBlock: string; toBlock: string; truncated: boolean; complete: boolean; maxBlocks: string };
  stale: boolean;
  staleReason?: string;
  /** Set when this is an older snapshot served because the read just failed. */
  degraded?: string;
  positionsCreated: number;
  listings: { announced: number; announcedByTeam: number; sold: number; cancelled: number; expired: number; revoked: number };
  /** `demo` is how many of `count` were announced by the team's own wallets. */
  activeListings: { count: number; demo: number; exact: boolean; checked: number; note: string };
  /** Distinct addresses in the logs, split into the team's and everyone else's. `others` is shown even when it is zero. */
  participants: { distinct: number; team: number; others: number };
  sales: { count: number; volumeWei: string; feesWei: string };
  policies: { set: number };
  keeper: { actions: number; byKind: Tally["keeper"]["byKind"]; tipsWei: string; keepers: number };
  /** What the planner says right now for vaults with a policy. Failed transactions leave no log, so past refusals cannot be counted. */
  planner: { total: number; sampled: number; unreadable: number; wouldAct: number; holds: Record<string, number> };
  ignoredVaultLogs: number;
}

export class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatsError";
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reads the head, retrying while the node that answers looks stale. If it never looks fresh the last answer comes back flagged. */
async function freshHead(chain: StatsChain, o: SnapshotOptions, now: () => number, sleep: (ms: number) => Promise<void>): Promise<{ head: Head; freshness: Freshness }> {
  let last: { head: Head; freshness: Freshness } | undefined;
  let error: unknown;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const head = await chain.head();
      const freshness = assess(head, o.tracker, now() / 1000);
      last = { head, freshness };
      if (!freshness.stale) return last;
    } catch (e) {
      error = e;
    }
    if (i < MAX_ATTEMPTS - 1) await sleep(400 * (i + 1));
  }
  if (last) return last;
  throw new StatsError(`The RPC did not answer: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
}

/**
 * One window, retried. An answer from a node whose own head is below the end of the window is not trusted, since that
 * node may be missing the newest blocks of it, and the next request usually reaches another node.
 */
async function readWindow(chain: StatsChain, from: bigint, to: bigint, sleep: (ms: number) => Promise<void>) {
  let why = "";
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const r = await chain.window(from, to);
      if (r.nodeHead >= to) return r;
      why = `a node at block ${r.nodeHead} answered for blocks up to ${to}`;
    } catch (e) {
      why = e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e);
    }
    if (i < MAX_ATTEMPTS - 1) await sleep(400 * (i + 1));
  }
  throw new StatsError(`Could not read blocks ${from} to ${to}: ${why}`);
}

/**
 * Builds the numbers for /stats and /api/stats. Reads are capped (`maxBlocks`, `budgetMs`, `maxChecks`,
 * `maxPreviews`) and every cap that bites is reported in the result, never hidden. Throws StatsError when the chain
 * cannot be read at all; the caller decides whether an older snapshot can stand in.
 */
export async function buildSnapshot(chain: StatsChain, state: ScanState | undefined, o: SnapshotOptions): Promise<{ snapshot: StatsSnapshot; state: ScanState }> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? wait;
  const startedAt = now();

  const { head, freshness } = await freshHead(chain, o, now, sleep);
  const { from, truncated } = scanStart(o.deployBlock, head.number, o.maxBlocks);

  // a cache from a shorter or different range is dropped when the start has moved up
  let s: ScanState = state && state.from <= from ? state : { from, to: from - 1n, factory: [], market: [], vaults: [] };
  if (state && state.from < from) {
    const keep = (l: StatLog) => l.blockNumber >= from;
    s = { from, to: state.to, factory: state.factory.filter(keep), market: state.market.filter(keep), vaults: state.vaults.filter(keep) };
  }

  let complete = true;
  let first = true;
  for (const [lo, hi] of windows(s.to + 1n, head.number, o.windowSize)) {
    if (!first && now() - startedAt > o.budgetMs) {
      complete = false;
      break;
    }
    first = false;
    const r = await readWindow(chain, lo, hi, sleep);
    s = { ...s, to: hi, factory: [...s.factory, ...r.factory], market: [...s.market, ...r.market], vaults: [...s.vaults, ...r.vaults] };
  }

  const team = [...(o.team ?? [])].map((a) => a.toLowerCase());
  const t = tally({ factory: s.factory, market: s.market, vaults: s.vaults, nowSeconds: head.timestamp, team });
  const isDemo = (c: OpenCandidate) => team.includes(c.seller.toLowerCase());

  // which open-looking listings the market would still settle
  let active: StatsSnapshot["activeListings"];
  if (t.listings.candidates.length <= o.maxChecks) {
    const states = await Promise.allSettled(t.listings.candidates.map((c) => chain.checkListing(c)));
    const okIdx = states.flatMap((x, i) => (x.status === "fulfilled" && stateName(x.value) === "Ok" ? [i] : []));
    const ok = okIdx.length;
    const demo = okIdx.filter((i) => isDemo(t.listings.candidates[i])).length;
    const failed = states.filter((x) => x.status === "rejected").length;
    active = failed
      ? { count: ok, demo, exact: false, checked: states.length - failed, note: `${failed} listing${failed === 1 ? "" : "s"} could not be checked, so this may be low.` }
      : { count: ok, demo, exact: true, checked: states.length, note: "Each listing was checked with the market's own check()." };
  } else {
    active = {
      count: t.listings.openByLogs, demo: t.listings.candidates.filter(isDemo).length, exact: false, checked: 0,
      note: `More than ${o.maxChecks} listings look open in the logs, so they were not checked one by one. Some may no longer be able to settle.`,
    };
  }

  // what the planner would do right now, for a bounded sample of vaults with a policy
  const sample = t.policies.vaults.slice(0, o.maxPreviews);
  const previews = await Promise.allSettled(sample.map((v) => chain.preview(v)));
  const holds: Record<string, number> = {};
  let wouldAct = 0;
  let unreadable = 0;
  for (const p of previews) {
    if (p.status === "rejected") {
      unreadable++;
      continue;
    }
    if (kindName(p.value.kind) !== "None") wouldAct++;
    else holds[reasonName(p.value.reason)] = (holds[reasonName(p.value.reason)] ?? 0) + 1;
  }

  const snapshot: StatsSnapshot = {
    generatedAt: new Date(now()).toISOString(),
    head: { block: head.number.toString(), timestamp: Number(head.timestamp), ageSeconds: freshness.ageSeconds },
    asOfBlock: s.to.toString(),
    range: { fromBlock: s.from.toString(), toBlock: s.to.toString(), truncated, complete, maxBlocks: o.maxBlocks.toString() },
    stale: freshness.stale,
    ...(freshness.stale ? { staleReason: freshness.reason } : {}),
    positionsCreated: t.positionsCreated,
    listings: { announced: t.listings.announced, announcedByTeam: t.listings.announcedByTeam, sold: t.listings.sold, cancelled: t.listings.cancelled, expired: t.listings.expired, revoked: t.listings.revoked },
    activeListings: active,
    participants: t.participants,
    sales: { count: t.sales.count, volumeWei: t.sales.volume.toString(), feesWei: t.sales.fees.toString() },
    policies: { set: t.policies.set },
    keeper: { actions: t.keeper.actions, byKind: t.keeper.byKind, tipsWei: t.keeper.tips.toString(), keepers: t.keeper.keepers },
    planner: { total: t.policies.set, sampled: sample.length, unreadable, wouldAct, holds },
    ignoredVaultLogs: t.ignoredVaultLogs,
  };
  return { snapshot, state: s };
}
