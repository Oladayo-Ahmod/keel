import { describe, expect, it } from "vitest";
import { collectAlerts } from "../src/check.js";
import { chain, E18 } from "./fixture.js";

const pct = (n: number) => (BigInt(Math.round(n * 100)) * E18) / 10_000n;

async function alertsFor(o: Parameters<typeof chain>[0], margin = 10, range: [bigint, bigint] = [16_699_000n, 16_700_000n]) {
  const c = chain(o);
  return { c, alerts: await collectAlerts({ trozu: c.trozu, client: c.client, tokenIds: [7n], marginPoints: margin, fromBlock: range[0], toBlock: range[1] }) };
}

describe("near the floor", () => {
  it("is quiet when the ratio is comfortably above the floor", async () => {
    // 145% against a 130% floor is 15 points of room, the margin is 10
    expect((await alertsFor({})).alerts).toEqual([]);
  });

  it("warns inside the margin", async () => {
    const { alerts } = await alertsFor({ icr: pct(138) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "near-floor", severity: "warning", tokenId: "7", key: "near-floor:7" });
    expect(alerts[0]!.message).toContain("Position #7 is at 138% against its 130% floor, 8 points of room.");
    expect(alerts[0]!.data).toMatchObject({ icrPercent: 138, floorPercent: 130, marginPoints: 8 });
  });

  it("alerts exactly at the margin, and not a point beyond it", async () => {
    expect((await alertsFor({ icr: pct(140) })).alerts).toHaveLength(1);
    expect((await alertsFor({ icr: pct(140.01) })).alerts).toHaveLength(0);
  });

  it("is critical under the floor, and says how far", async () => {
    const { alerts } = await alertsFor({ icr: pct(125), kind: 1, reason: 0 });
    expect(alerts[0]).toMatchObject({ severity: "critical", title: "Position #7 is under its guardian floor" });
    expect(alerts[0]!.message).toContain("5 points under it");
    expect(alerts[0]!.message).toContain("The guardian is ready to act (TopUpBtc)");
  });

  it("is critical when the guardian is near the floor but has no reserve to act with", async () => {
    const { alerts } = await alertsFor({ icr: pct(132), reason: 7, reserveBtc: 0n });
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.message).toContain("cannot act");
  });

  it("uses the margin it is given", async () => {
    expect((await alertsFor({ icr: pct(145) }, 20)).alerts).toHaveLength(1);
    expect((await alertsFor({ icr: pct(131) }, 0)).alerts).toHaveLength(0);
  });

  it("says nothing about a position that has no live policy, however low it is", async () => {
    expect((await alertsFor({ live: false, icr: pct(105), reason: 1 })).alerts).toEqual([]);
  });

  it("says nothing when the price feed is down and the ratio is not known", async () => {
    expect((await alertsFor({ icr: 0n, reason: 4 })).alerts).toEqual([]);
  });

  it("says nothing for a trove with no debt", async () => {
    expect((await alertsFor({ icr: 2n ** 256n - 1n })).alerts).toEqual([]);
  });
});

describe("keeper actions", () => {
  it("reports a guardian action in the block range with what it did", async () => {
    const c = chain();
    c.action(1, E18 / 20n, 5n * 10n ** 13n, pct(129.5), 16_699_500n);
    const alerts = await collectAlerts({ trozu: c.trozu, client: c.client, tokenIds: [7n], marginPoints: 10, fromBlock: 16_699_000n, toBlock: 16_700_000n });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "keeper-acted", severity: "info" });
    expect(alerts[0]!.message).toBe("Position #7: TopUpBtc of 0.05 BTC from the reserve, at 129.5% before. Keeper tip 0.00005 BTC. Block 16699500.");
    expect(alerts[0]!.data).toMatchObject({ kind: "TopUpBtc", icrBeforePercent: 129.5 });
  });

  it("names a repayment in MUSD", async () => {
    const c = chain();
    c.action(2, 100n * E18, 0n, pct(128), 16_699_500n);
    const [a] = await collectAlerts({ trozu: c.trozu, client: c.client, tokenIds: [7n], marginPoints: 10, fromBlock: 16_699_000n, toBlock: 16_700_000n });
    expect(a!.message).toContain("RepayMusd of 100 MUSD");
  });

  it("ignores actions outside the block range", async () => {
    const c = chain();
    c.action(1, E18, 0n, pct(129), 16_000_000n);
    c.action(1, E18, 0n, pct(129), 16_700_001n);
    expect(await collectAlerts({ trozu: c.trozu, client: c.client, tokenIds: [7n], marginPoints: 10, fromBlock: 16_699_000n, toBlock: 16_700_000n })).toEqual([]);
  });

  it("reads a long range in windows the public RPC accepts", async () => {
    const c = chain();
    c.action(1, E18, 0n, pct(129), 16_660_000n);
    const alerts = await collectAlerts({ trozu: c.trozu, client: c.client, tokenIds: [7n], marginPoints: 10, fromBlock: 16_650_000n, toBlock: 16_700_000n });
    expect(alerts).toHaveLength(1);
    const windows = c.m.requests.filter((r) => r.method === "eth_getLogs").map((r) => {
      const f = (r.params as { fromBlock: string; toBlock: string }[])[0]!;
      return BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n;
    });
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w).toBeLessThanOrEqual(9_000n);
  });

  it("gives each action its own key", async () => {
    const c = chain();
    c.action(1, E18, 0n, pct(129), 16_699_100n);
    c.action(1, E18, 0n, pct(129), 16_699_200n);
    const alerts = await collectAlerts({ trozu: c.trozu, client: c.client, tokenIds: [7n], marginPoints: 10, fromBlock: 16_699_000n, toBlock: 16_700_000n });
    expect(new Set(alerts.map((a) => a.key)).size).toBe(2);
  });
});

describe("what an alert may contain", () => {
  it("is built from numbers, hashes and addresses only", async () => {
    const c = chain({ icr: pct(125), kind: 1, reason: 0 });
    c.action(1, E18, 0n, pct(129), 16_699_100n);
    const alerts = await collectAlerts({ trozu: c.trozu, client: c.client, tokenIds: [7n], marginPoints: 10, fromBlock: 16_699_000n, toBlock: 16_700_000n });
    for (const a of alerts) expect(a.message + a.title).toMatch(/^[\w\s#%.,:()'\-—•🔴🟠🔵]*$/u);
  });
});
