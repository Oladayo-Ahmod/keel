import { describe, expect, it } from "vitest";
import { createTracker } from "./freshness";
import { StatsError, buildSnapshot, type ScanState, type SnapshotOptions, type StatsChain } from "./statsSnapshot";
import type { StatLog } from "./stats";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const NOW_MS = 2_000_000_000_000;
const HEAD = 1_000n;

let idx = 0;
const log = (eventName: string, address: `0x${string}`, args: Record<string, unknown>, block: bigint): StatLog => ({
  eventName, address, args, blockNumber: block, logIndex: idx++,
});

interface FakeOpts {
  head?: bigint;
  headTimestamp?: bigint;
  factory?: StatLog[];
  market?: StatLog[];
  vaults?: StatLog[];
  /** Throw this many times before a window answers. */
  failWindows?: number;
  /** Answer windows with a head this far behind the window end, this many times. */
  lagWindows?: number;
  checkState?: number;
  previewThrows?: boolean;
}

function fake(f: FakeOpts = {}) {
  const calls = { windows: [] as Array<[bigint, bigint]>, heads: 0, checks: 0, previews: 0 };
  let fails = f.failWindows ?? 0;
  let lags = f.lagWindows ?? 0;
  const between = (l: StatLog[] | undefined, a: bigint, b: bigint) => (l ?? []).filter((x) => x.blockNumber >= a && x.blockNumber <= b);
  const chain: StatsChain = {
    async head() {
      calls.heads++;
      return { number: f.head ?? HEAD, timestamp: f.headTimestamp ?? BigInt(NOW_MS / 1000 - 5) };
    },
    async window(from, to) {
      calls.windows.push([from, to]);
      if (fails > 0) {
        fails--;
        throw new Error("connection dropped");
      }
      if (lags > 0) {
        lags--;
        return { nodeHead: to - 5n, factory: [], market: [], vaults: [] };
      }
      return { nodeHead: to, factory: between(f.factory, from, to), market: between(f.market, from, to), vaults: between(f.vaults, from, to) };
    },
    async checkListing() {
      calls.checks++;
      return f.checkState ?? 0;
    },
    async preview() {
      calls.previews++;
      if (f.previewThrows) throw new Error("price feed down");
      return { kind: 0, reason: 5 };
    },
  };
  return { chain, calls };
}

const opts = (over: Partial<SnapshotOptions> = {}): SnapshotOptions => ({
  deployBlock: 100n,
  maxBlocks: 10_000n,
  windowSize: 300n,
  budgetMs: 8_000,
  maxChecks: 10,
  maxPreviews: 5,
  tracker: createTracker(),
  now: () => NOW_MS,
  sleep: async () => undefined,
  ...over,
});

const created = (vault: number, block = 150n) => log("PositionCreated", addr(1), { vault: addr(vault), tokenId: BigInt(vault), holder: addr(5) }, block);
const announce = (h: number, block = 200n, deadline = BigInt(NOW_MS / 1000 + 1000)) =>
  log("ListingAnnounced", addr(9), { hash: hash(h), seller: addr(50), tokenId: 1n, listing: { nonce: 0n, deadline, seller: addr(50), tokenId: 1n }, signature: "0x" }, block);

describe("stats snapshot", () => {
  it("reads from the deploy block to the head in windows and counts what it finds", async () => {
    const { chain, calls } = fake({
      factory: [created(10), created(11, 750n)],
      market: [announce(1), log("Sold", addr(9), { hash: hash(1), seller: addr(50), buyer: addr(60), tokenId: 1n, recipient: addr(60), price: 2_000n * 10n ** 18n, fee: 5n * 10n ** 18n }, 400n)],
      vaults: [log("PolicySet", addr(10), {}, 300n), log("GuardianAction", addr(10), { keeper: addr(70), kind: 1n, amount: 1n, tip: 3n, icrBefore: 1n }, 500n)],
    });
    const { snapshot } = await buildSnapshot(chain, undefined, opts());
    expect(calls.windows[0]).toEqual([100n, 399n]);
    expect(calls.windows.at(-1)).toEqual([1000n, 1000n]);
    expect(snapshot.positionsCreated).toBe(2);
    expect(snapshot.sales).toEqual({ count: 1, volumeWei: (2_000n * 10n ** 18n).toString(), feesWei: (5n * 10n ** 18n).toString() });
    expect(snapshot.policies.set).toBe(1);
    expect(snapshot.keeper).toMatchObject({ actions: 1, tipsWei: "3", keepers: 1 });
    expect(snapshot.range).toMatchObject({ fromBlock: "100", toBlock: "1000", truncated: false, complete: true });
    expect(snapshot.stale).toBe(false);
    expect(snapshot.generatedAt).toBe(new Date(NOW_MS).toISOString());
  });

  it("caps the range, starts later and says the counts are not all time", async () => {
    const { chain, calls } = fake({ head: 5_000n });
    const { snapshot } = await buildSnapshot(chain, undefined, opts({ maxBlocks: 600n }));
    expect(calls.windows[0][0]).toBe(4_401n);
    expect(snapshot.range).toMatchObject({ fromBlock: "4401", truncated: true, maxBlocks: "600" });
  });

  it("resumes after the last block it read instead of reading everything again", async () => {
    const f = fake({ factory: [created(10)] });
    const first = await buildSnapshot(f.chain, undefined, opts());
    const second = fake({ factory: [created(10), created(12, 1_010n)], head: 1_020n });
    const r = await buildSnapshot(second.chain, first.state, opts());
    expect(second.calls.windows).toEqual([[1_001n, 1_020n]]);
    expect(r.snapshot.positionsCreated).toBe(2);
  });

  it("drops cached logs below a start that moved up", async () => {
    const f = fake({ factory: [created(10, 150n)] });
    const first = await buildSnapshot(f.chain, undefined, opts());
    const later = fake({ head: 5_000n });
    const r = await buildSnapshot(later.chain, first.state, opts({ maxBlocks: 600n }));
    expect(r.state.factory).toHaveLength(0);
    expect(r.snapshot.positionsCreated).toBe(0);
  });

  it("retries a window after a dropped connection", async () => {
    const { chain, calls } = fake({ failWindows: 2, factory: [created(10)] });
    const { snapshot } = await buildSnapshot(chain, undefined, opts());
    expect(snapshot.positionsCreated).toBe(1);
    expect(calls.windows.filter(([a]) => a === 100n)).toHaveLength(3);
  });

  it("throws a plain error when a window never answers", async () => {
    const { chain } = fake({ failWindows: 99 });
    await expect(buildSnapshot(chain, undefined, opts())).rejects.toThrow(StatsError);
    await expect(buildSnapshot(fake({ failWindows: 99 }).chain, undefined, opts())).rejects.toThrow(/Could not read blocks 100 to 399/);
  });

  it("does not trust a node that is behind the window it was asked about", async () => {
    const { chain, calls } = fake({ lagWindows: 1, factory: [created(10)] });
    const { snapshot } = await buildSnapshot(chain, undefined, opts());
    expect(calls.windows.filter(([a]) => a === 100n)).toHaveLength(2);
    expect(snapshot.positionsCreated).toBe(1);
  });

  it("gives up on a node that stays behind", async () => {
    const { chain } = fake({ lagWindows: 99 });
    await expect(buildSnapshot(chain, undefined, opts())).rejects.toThrow(/node at block/);
  });

  it("flags a head block that is old", async () => {
    const { chain } = fake({ headTimestamp: BigInt(NOW_MS / 1000 - 3_600) });
    const { snapshot } = await buildSnapshot(chain, undefined, opts());
    expect(snapshot.stale).toBe(true);
    expect(snapshot.staleReason).toMatch(/seconds old/);
    expect(snapshot.head.ageSeconds).toBe(3_600);
  });

  it("flags a head far behind the newest one seen", async () => {
    const tracker = createTracker();
    tracker.observe({ number: 9_000n, timestamp: BigInt(NOW_MS / 1000) });
    const { snapshot } = await buildSnapshot(fake().chain, undefined, opts({ tracker }));
    expect(snapshot.stale).toBe(true);
    expect(snapshot.staleReason).toMatch(/behind the newest block/);
  });

  it("throws when the head cannot be read", async () => {
    const chain: StatsChain = { ...fake().chain, head: async () => { throw new Error("socket hang up"); } };
    await expect(buildSnapshot(chain, undefined, opts())).rejects.toThrow(/RPC did not answer: socket hang up/);
  });

  it("stops reading new windows when the time budget runs out and says it is incomplete", async () => {
    let t = NOW_MS;
    const { chain, calls } = fake();
    const { snapshot, state } = await buildSnapshot(chain, undefined, opts({ budgetMs: 1_000, now: () => (t += 600) }));
    expect(snapshot.range.complete).toBe(false);
    expect(calls.windows.length).toBeLessThan(4);
    expect(calls.windows.length).toBeGreaterThanOrEqual(1);
    expect(state.to).toBeLessThan(HEAD);
  });

  it("checks each open-looking listing with the market and counts only the ones that can settle", async () => {
    const m = fake({ market: [announce(1), announce(2)], checkState: 0 });
    expect((await buildSnapshot(m.chain, undefined, opts())).snapshot.activeListings).toMatchObject({ count: 2, exact: true, checked: 2 });
    const refused = fake({ market: [announce(1), announce(2)], checkState: 8 }); // NotOwner
    expect((await buildSnapshot(refused.chain, undefined, opts())).snapshot.activeListings).toMatchObject({ count: 0, exact: true });
  });

  it("marks open listings from the team as demo listings and counts other addresses, shown even at zero", async () => {
    const mk = (h: number, seller: number) => ({ ...announce(h), args: { ...announce(h).args, seller: addr(seller), listing: { nonce: 0n, deadline: BigInt(NOW_MS / 1000 + 1000), seller: addr(seller), tokenId: 1n } } });
    const only = fake({ market: [mk(1, 50), mk(2, 50)], checkState: 0 });
    const a = (await buildSnapshot(only.chain, undefined, opts({ team: [addr(50).toUpperCase().replace("0X", "0x")] }))).snapshot;
    expect(a.activeListings).toMatchObject({ count: 2, demo: 2 });
    expect(a.listings.announcedByTeam).toBe(2);
    expect(a.participants).toEqual({ distinct: 1, team: 1, others: 0 });

    const mixed = fake({ market: [mk(1, 50), mk(2, 99)], checkState: 0 });
    const b = (await buildSnapshot(mixed.chain, undefined, opts({ team: [addr(50)] }))).snapshot;
    expect(b.activeListings).toMatchObject({ count: 2, demo: 1 });
    expect(b.participants).toEqual({ distinct: 2, team: 1, others: 1 });
  });

  it("counts demo listings only among the ones the market would settle", async () => {
    const m = fake({ market: [announce(1)], checkState: 8 });
    const s = (await buildSnapshot(m.chain, undefined, opts({ team: [addr(50)] }))).snapshot;
    expect(s.activeListings).toMatchObject({ count: 0, demo: 0 });
  });

  it("falls back to the log count, flagged inexact, when there are too many listings to check", async () => {
    const m = fake({ market: Array.from({ length: 12 }, (_, i) => announce(i + 1)) });
    const { snapshot } = await buildSnapshot(m.chain, undefined, opts({ maxChecks: 10 }));
    expect(m.calls.checks).toBe(0);
    expect(snapshot.activeListings).toMatchObject({ count: 12, exact: false, checked: 0 });
    expect(snapshot.activeListings.note).toMatch(/More than 10/);
  });

  it("does not fail the page when a listing check throws", async () => {
    const m = fake({ market: [announce(1)] });
    m.chain.checkListing = async () => { throw new Error("rpc"); };
    const { snapshot } = await buildSnapshot(m.chain, undefined, opts());
    expect(snapshot.activeListings.exact).toBe(false);
    expect(snapshot.activeListings.note).toMatch(/could not be checked/);
  });

  it("samples at most maxPreviews vaults and reports what the planner holds on", async () => {
    const vaults = Array.from({ length: 8 }, (_, i) => 10 + i);
    const m = fake({ factory: vaults.map((v) => created(v)), vaults: vaults.map((v) => log("PolicySet", addr(v), {}, 300n)) });
    const { snapshot } = await buildSnapshot(m.chain, undefined, opts({ maxPreviews: 5 }));
    expect(m.calls.previews).toBe(5);
    expect(snapshot.planner).toMatchObject({ total: 8, sampled: 5, wouldAct: 0, unreadable: 0, holds: { Healthy: 5 } });
  });

  it("counts planner reads that fail instead of failing the page", async () => {
    const m = fake({ factory: [created(10)], vaults: [log("PolicySet", addr(10), {}, 300n)], previewThrows: true });
    const { snapshot } = await buildSnapshot(m.chain, undefined, opts());
    expect(snapshot.planner).toMatchObject({ sampled: 1, unreadable: 1, wouldAct: 0 });
  });

  it("returns a state that can be fed back in", async () => {
    const r = await buildSnapshot(fake().chain, undefined, opts());
    const s: ScanState = r.state;
    expect(s.to).toBe(HEAD);
    expect(s.from).toBe(100n);
  });
});
