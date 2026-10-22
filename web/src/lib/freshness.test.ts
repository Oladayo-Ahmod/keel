import { describe, expect, it } from "vitest";
import { MAX_AGE_SECONDS, MAX_LAG_BLOCKS, assess, createTracker, readFresh, type Head } from "./freshness";

const head = (n: number, ts: number): Head => ({ number: BigInt(n), timestamp: BigInt(ts) });
const NOW = 1_800_000_000;
const noSleep = async () => undefined;

describe("assess", () => {
  it("accepts a recent head", () => {
    const t = createTracker();
    const f = assess(head(1000, NOW - 5), t, NOW);
    expect(f.stale).toBe(false);
    expect(f.ageSeconds).toBe(5);
  });

  it("flags a node far behind the newest block seen", () => {
    const t = createTracker();
    assess(head(1000, NOW - 2), t, NOW);
    const f = assess(head(1000 - Number(MAX_LAG_BLOCKS) - 1, NOW - 2), t, NOW);
    expect(f.stale).toBe(true);
    expect(f.reason).toMatch(/blocks behind/);
  });

  it("tolerates a node that is only a few blocks behind", () => {
    const t = createTracker();
    assess(head(1000, NOW), t, NOW);
    expect(assess(head(1000 - Number(MAX_LAG_BLOCKS), NOW), t, NOW).stale).toBe(false);
  });

  it("flags an old head even when it is the only one seen", () => {
    const t = createTracker();
    const f = assess(head(5, NOW - MAX_AGE_SECONDS - 1), t, NOW);
    expect(f.stale).toBe(true);
    expect(f.reason).toMatch(/seconds old/);
  });

  it("never moves the highest block backwards", () => {
    const t = createTracker();
    assess(head(2000, NOW), t, NOW);
    assess(head(10, NOW), t, NOW);
    expect(t.highest?.number).toBe(2000n);
  });

  it("matches the failure seen on matsnet: 16,082,514 against 16,296,884", () => {
    const t = createTracker();
    assess(head(16_296_884, NOW - 3), t, NOW);
    expect(assess(head(16_082_514, NOW - 3), t, NOW).stale).toBe(true);
  });

  it("does not report a negative age for a head from the future", () => {
    const t = createTracker();
    expect(assess(head(1, NOW + 30), t, NOW).ageSeconds).toBe(0);
  });
});

describe("readFresh", () => {
  it("returns at once when the first read is fresh", async () => {
    const t = createTracker();
    let calls = 0;
    const r = await readFresh({
      tracker: t,
      now: () => NOW,
      sleep: noSleep,
      read: async () => {
        calls++;
        return { head: head(100, NOW - 1), data: "ok" };
      },
    });
    expect(calls).toBe(1);
    expect(r.data).toBe("ok");
    expect(r.freshness.stale).toBe(false);
  });

  it("retries a stale answer and returns the fresh one", async () => {
    const t = createTracker();
    t.observe(head(5000, NOW));
    const answers = [
      { head: head(100, NOW - 1), data: "old" },
      { head: head(100, NOW - 1), data: "old" },
      { head: head(5000, NOW - 1), data: "new" },
    ];
    let i = 0;
    const r = await readFresh({ tracker: t, now: () => NOW, sleep: noSleep, read: async () => answers[i++] });
    expect(r.data).toBe("new");
    expect(r.freshness.stale).toBe(false);
    expect(i).toBe(3);
  });

  it("flags the data when every attempt is stale, instead of passing it off as fresh", async () => {
    const t = createTracker();
    t.observe(head(5000, NOW));
    let calls = 0;
    const r = await readFresh({
      tracker: t,
      now: () => NOW,
      sleep: noSleep,
      attempts: 3,
      read: async () => {
        calls++;
        return { head: head(100, NOW - 1), data: "old" };
      },
    });
    expect(calls).toBe(3);
    expect(r.data).toBe("old");
    expect(r.freshness.stale).toBe(true);
  });

  it("retries a read that throws, then succeeds", async () => {
    const t = createTracker();
    let i = 0;
    const r = await readFresh({
      tracker: t,
      now: () => NOW,
      sleep: noSleep,
      read: async () => {
        if (i++ < 2) throw new Error("TLS");
        return { head: head(100, NOW), data: "fine" };
      },
    });
    expect(r.data).toBe("fine");
  });

  it("rethrows when every attempt throws", async () => {
    await expect(
      readFresh({
        tracker: createTracker(),
        now: () => NOW,
        sleep: noSleep,
        attempts: 2,
        read: async () => {
          throw new Error("down");
        },
      }),
    ).rejects.toThrow("down");
  });
});
