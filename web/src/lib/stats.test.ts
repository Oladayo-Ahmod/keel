import { describe, expect, it } from "vitest";
import { ageText, scanStart, tally, windows, type StatLog } from "./stats";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const MARKET = addr(900);
const NOW = 1_000_000n;

let idx = 0;
const log = (eventName: string, address: `0x${string}`, args: Record<string, unknown>, block = 100n): StatLog => ({
  eventName, address, args, blockNumber: block, logIndex: idx++,
});

const created = (vault: number, tokenId = 1n) => log("PositionCreated", addr(1), { vault: addr(vault), tokenId, holder: addr(5) });
const announce = (h: number, seller: number, nonce = 0n, deadline = NOW + 1000n, tokenId = 1n) =>
  log("ListingAnnounced", MARKET, { hash: hash(h), seller: addr(seller), tokenId, listing: { nonce, deadline, seller: addr(seller), tokenId }, signature: "0x" });
const sale = (h: number, price: bigint, fee: bigint) =>
  log("Sold", MARKET, { hash: hash(h), seller: addr(50), buyer: addr(60), tokenId: 1n, recipient: addr(60), price, fee });
const action = (vault: number, kind: number, tip: bigint, keeper = 70) =>
  log("GuardianAction", addr(vault), { keeper: addr(keeper), kind, amount: 1n, tip, icrBefore: 1n });

const run = (p: Partial<{ factory: StatLog[]; market: StatLog[]; vaults: StatLog[] }>) =>
  tally({ factory: [], market: [], vaults: [], nowSeconds: NOW, ...p });

describe("stats tally", () => {
  it("is all zeros with no logs", () => {
    const t = run({});
    expect(t.positionsCreated).toBe(0);
    expect(t.sales).toEqual({ count: 0, volume: 0n, fees: 0n });
    expect(t.listings.openByLogs).toBe(0);
    expect(t.keeper.actions).toBe(0);
    expect(t.policies.set).toBe(0);
  });

  it("counts created positions by vault", () => {
    expect(run({ factory: [created(10), created(11, 2n), created(10)] }).positionsCreated).toBe(2);
  });

  it("sums sale volume and fees", () => {
    const t = run({ market: [announce(1, 50), announce(2, 50), sale(1, 2_000n, 5n), sale(2, 1_500n, 4n)] });
    expect(t.sales).toEqual({ count: 2, volume: 3_500n, fees: 9n });
    expect(t.listings.sold).toBe(2);
    expect(t.listings.openByLogs).toBe(0);
  });

  it("counts a sale whose listing was never announced", () => {
    const t = run({ market: [sale(9, 100n, 1n)] });
    expect(t.sales.count).toBe(1);
    expect(t.listings.announced).toBe(0);
  });

  it("separates open, expired, cancelled and revoked listings", () => {
    const t = run({
      market: [
        announce(1, 50), // open
        announce(2, 50, 0n, NOW - 1n), // expired
        announce(3, 50), // cancelled
        log("ListingCancelled", MARKET, { hash: hash(3), seller: addr(50), tokenId: 1n }),
        announce(4, 51, 0n), // revoked by a nonce raise
        log("AllListingsCancelled", MARKET, { seller: addr(51), newNonce: 1n }),
        announce(5, 51, 1n), // signed under the new nonce, still open
      ],
    });
    expect(t.listings).toMatchObject({ announced: 5, sold: 0, cancelled: 1, expired: 1, revoked: 1, openByLogs: 2 });
    expect(t.listings.candidates.map((c) => c.hash).sort()).toEqual([hash(1), hash(5)].sort());
  });

  it("treats a deadline equal to now as expired", () => {
    expect(run({ market: [announce(1, 50, 0n, NOW)] }).listings.expired).toBe(1);
  });

  it("gives each listing one reason, sold before cancelled", () => {
    const t = run({ market: [announce(1, 50), sale(1, 10n, 1n), log("ListingCancelled", MARKET, { hash: hash(1), seller: addr(50), tokenId: 1n })] });
    expect(t.listings.sold).toBe(1);
    expect(t.listings.cancelled).toBe(0);
  });

  it("does not double count a listing announced twice", () => {
    expect(run({ market: [announce(1, 50), announce(1, 50)] }).listings.announced).toBe(1);
  });

  it("counts a policy that was set, and not one that was cleared", () => {
    const t = run({
      factory: [created(10), created(11), created(12)],
      vaults: [
        log("PolicySet", addr(10), {}),
        log("PolicySet", addr(11), {}),
        log("PolicyCleared", addr(11), {}),
        log("PolicySet", addr(12), {}),
        log("PolicyCleared", addr(12), {}),
        log("PolicySet", addr(12), {}), // set again after clearing
      ],
    });
    expect(t.policies.set).toBe(2);
    expect(t.policies.vaultsWithHistory).toBe(3);
  });

  it("reads policy events in block order, not array order", () => {
    const t = run({
      factory: [created(10)],
      vaults: [log("PolicyCleared", addr(10), {}, 200n), log("PolicySet", addr(10), {}, 100n)],
    });
    expect(t.policies.set).toBe(0);
  });

  it("ignores vault events from addresses the factory did not create", () => {
    const t = run({
      factory: [created(10)],
      vaults: [log("PolicySet", addr(99), {}), action(99, 1, 5n), action(10, 1, 7n)],
    });
    expect(t.policies.set).toBe(0);
    expect(t.keeper.actions).toBe(1);
    expect(t.keeper.tips).toBe(7n);
    expect(t.ignoredVaultLogs).toBe(2);
  });

  it("splits keeper actions by kind and counts distinct keepers", () => {
    const t = run({
      factory: [created(10), created(11)],
      vaults: [action(10, 1, 1n, 70), action(10, 2, 1n, 70), action(11, 3, 0n, 71), action(11, 1, 2n, 71)],
    });
    expect(t.keeper.byKind).toEqual({ TopUpBtc: 2, RepayMusd: 1, DefendBtc: 1, other: 0 });
    expect(t.keeper.keepers).toBe(2);
    expect(t.keeper.tips).toBe(4n);
  });

  it("matches vault addresses case-insensitively", () => {
    const upper = "0x" + "AB".repeat(20);
    const t = run({
      factory: [log("PositionCreated", addr(1), { vault: upper, tokenId: 1n, holder: addr(5) })],
      vaults: [action(0, 1, 1n)].map((l) => ({ ...l, address: upper.toLowerCase() as `0x${string}` })),
    });
    expect(t.keeper.actions).toBe(1);
  });
});

describe("scan window helpers", () => {
  it("cuts a range into windows that never exceed the size", () => {
    const w = windows(0n, 25n, 10n);
    expect(w).toEqual([[0n, 9n], [10n, 19n], [20n, 25n]]);
    expect(windows(5n, 4n, 10n)).toEqual([]);
    expect(windows(7n, 7n, 10n)).toEqual([[7n, 7n]]);
  });

  it("reads from the deploy block when the range fits", () => {
    expect(scanStart(100n, 500n, 1000n)).toEqual({ from: 100n, truncated: false });
    expect(scanStart(100n, 1099n, 1000n)).toEqual({ from: 100n, truncated: false });
  });

  it("moves the start up and says so when the range is too long", () => {
    expect(scanStart(100n, 1100n, 1000n)).toEqual({ from: 101n, truncated: true });
    expect(scanStart(100n, 5000n, 1000n)).toEqual({ from: 4001n, truncated: true });
  });

  it("handles a head below the deploy block", () => {
    expect(scanStart(100n, 50n, 1000n)).toEqual({ from: 100n, truncated: false });
  });

  it("words ages", () => {
    expect(ageText(12)).toBe("12 seconds");
    expect(ageText(300)).toBe("5 minutes");
    expect(ageText(7200)).toBe("2 hours");
    expect(ageText(-1)).toBe("unknown");
  });
});
