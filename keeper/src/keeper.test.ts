import { describe, expect, it, vi } from "vitest";

import { discover, runOnce, windows, withBackoff } from "./keeper.js";
import { ChainApi, ChainRevert, Hex, Kind, Plan } from "./types.js";

const V1 = "0x1111111111111111111111111111111111111111" as Hex;
const V2 = "0x2222222222222222222222222222222222222222" as Hex;
const SPOOF = "0x9999999999999999999999999999999999999999" as Hex;

const act: Plan = { kind: Kind.TopUpBtc, reason: 0, amount: 5n, tip: 1n, icr: 1_100_000_000_000_000_000n, resetWindow: false };
const healthy: Plan = { kind: Kind.None, reason: 5, amount: 0n, tip: 0n, icr: 2_000_000_000_000_000_000n, resetWindow: false };

const noSleep = async () => {};

/// A chain with sensible defaults; each test overrides what it cares about.
function mockChain(over: Partial<ChainApi> = {}): ChainApi & { sent: Hex[] } {
  const sent: Hex[] = [];
  return {
    sent,
    head: async () => 100n,
    createdVaults: async () => [V1, V2],
    policyEmitters: async () => [V1, V2],
    policyLive: async () => true,
    preview: async () => act,
    estimateExecute: async () => 100_000n,
    sendExecute: async (v) => {
      sent.push(v);
      return { hash: ("0x" + "ab".repeat(32)) as Hex, status: "success", gasUsed: 90_000n };
    },
    ...over,
  };
}

const base = { fromBlock: 0n, dryRun: false, sleep: noSleep };

describe("windows", () => {
  it("never exceeds the node's 10,000 block limit and covers every block once", () => {
    const w = windows(5n, 25_004n, 10_000n);
    expect(w).toEqual([[5n, 10_004n], [10_005n, 20_004n], [20_005n, 25_004n]]);
    for (const [lo, hi] of w) expect(hi - lo + 1n).toBeLessThanOrEqual(10_000n);
  });
  it("handles a range shorter than one window and an empty range", () => {
    expect(windows(0n, 5n, 10_000n)).toEqual([[0n, 5n]]);
    expect(windows(10n, 5n, 10_000n)).toEqual([]);
  });
});

describe("withBackoff", () => {
  it("retries a transient failure with doubling delays", async () => {
    const delays: number[] = [];
    let calls = 0;
    const out = await withBackoff(
      async () => {
        if (++calls < 3) throw new Error("socket hang up");
        return "ok";
      },
      { maxAttempts: 5, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) },
    );
    expect(out).toBe("ok");
    expect(delays).toEqual([100, 200]);
  });
  it("gives up after maxAttempts and throws the last error", async () => {
    let calls = 0;
    await expect(
      withBackoff(async () => { calls++; throw new Error("down"); }, { maxAttempts: 3, baseDelayMs: 1, sleep: noSleep }),
    ).rejects.toThrow("down");
    expect(calls).toBe(3);
  });
  it("does not retry a contract revert", async () => {
    let calls = 0;
    await expect(
      withBackoff(async () => { calls++; throw new ChainRevert("NothingToDo"); }, { maxAttempts: 5, baseDelayMs: 1, sleep: noSleep }),
    ).rejects.toBeInstanceOf(ChainRevert);
    expect(calls).toBe(1);
  });
});

describe("discover", () => {
  const opts = { fromBlock: 0n, windowSize: 10_000n, maxAttempts: 3, baseDelayMs: 1, sleep: noSleep };

  it("only trusts policy events from vaults the factory created", async () => {
    const api = mockChain({ policyEmitters: async () => [V1, SPOOF] });
    expect(await discover(api, opts)).toEqual([V1.toLowerCase()]);
  });
  it("scans every window and de-duplicates", async () => {
    const seen: Array<[bigint, bigint]> = [];
    const api = mockChain({
      head: async () => 25_000n,
      createdVaults: async (lo, hi) => { seen.push([lo, hi]); return [V1]; },
      policyEmitters: async () => [V1],
    });
    expect(await discover(api, opts)).toEqual([V1.toLowerCase()]);
    expect(seen.length).toBe(3);
  });
  it("survives a transient log failure", async () => {
    let n = 0;
    const api = mockChain({ createdVaults: async () => { if (n++ === 0) throw new Error("502"); return [V1]; }, policyEmitters: async () => [V1] });
    expect(await discover(api, opts)).toEqual([V1.toLowerCase()]);
  });
});

describe("runOnce", () => {
  it("sends execute where the planner says act, with a gas buffer on the estimate", async () => {
    const gases: bigint[] = [];
    const api = mockChain({
      sendExecute: async (v, gas) => { gases.push(gas); return { hash: ("0x" + "cd".repeat(32)) as Hex, status: "success", gasUsed: 1n }; },
    });
    const out = await runOnce(api, base);
    expect(out.map((o) => o.result)).toEqual(["sent", "sent"]);
    expect(gases).toEqual([120_000n, 120_000n]); // 100,000 x 120%
  });

  it("does nothing when the planner says there is nothing to do", async () => {
    const api = mockChain({ preview: async () => healthy });
    const out = await runOnce(api, base);
    expect(out.every((o) => o.result === "skipped")).toBe(true);
    expect(api.sent).toEqual([]);
  });

  it("skips a vault whose policy is not live without asking the planner", async () => {
    const preview = vi.fn(async () => act);
    const api = mockChain({ policyLive: async (v) => v === V1, preview });
    const out = await runOnce(api, base);
    expect(out.find((o) => o.vault.toLowerCase() === V2.toLowerCase())).toMatchObject({ result: "skipped", why: "policy not live" });
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("dry run estimates but never sends", async () => {
    const send = vi.fn();
    const api = mockChain({ sendExecute: send });
    const out = await runOnce(api, { ...base, dryRun: true });
    expect(out.map((o) => o.result)).toEqual(["would-send", "would-send"]);
    expect(out[0]).toMatchObject({ kind: "TopUpBtc", amount: 5n, tip: 1n, gas: 120_000n });
    expect(send).not.toHaveBeenCalled();
  });

  it("skips, and does not send, when the estimate says the call would revert", async () => {
    const api = mockChain({ estimateExecute: async () => { throw new ChainRevert("NothingToDo(5)"); } });
    const out = await runOnce(api, base);
    expect(out[0]).toMatchObject({ result: "skipped" });
    expect(api.sent).toEqual([]);
  });

  it("retries a flaky send with backoff and then succeeds", async () => {
    let tries = 0;
    const delays: number[] = [];
    const api = mockChain({
      createdVaults: async () => [V1],
      policyEmitters: async () => [V1],
      sendExecute: async () => {
        if (++tries < 3) throw new Error("connection reset");
        return { hash: ("0x" + "ef".repeat(32)) as Hex, status: "success", gasUsed: 5n };
      },
    });
    const out = await runOnce(api, { ...base, baseDelayMs: 50, sleep: async (ms) => void delays.push(ms) });
    expect(out[0].result).toBe("sent");
    expect(tries).toBe(3);
    expect(delays).toEqual([50, 100]);
  });

  it("reports a failure after the attempts run out, and still handles the other vaults", async () => {
    const api = mockChain({
      sendExecute: async (v) => {
        if (v === V1) throw new Error("rpc down");
        return { hash: ("0x" + "12".repeat(32)) as Hex, status: "success", gasUsed: 7n };
      },
    });
    const out = await runOnce(api, { ...base, maxAttempts: 2 });
    const byVault = Object.fromEntries(out.map((o) => [o.vault.toLowerCase(), o.result]));
    expect(byVault[V1.toLowerCase()]).toBe("failed");
    expect(byVault[V2.toLowerCase()]).toBe("sent");
  });

  it("reports a mined-but-reverted transaction as failed", async () => {
    const api = mockChain({
      createdVaults: async () => [V1],
      policyEmitters: async () => [V1],
      sendExecute: async () => ({ hash: ("0x" + "34".repeat(32)) as Hex, status: "reverted", gasUsed: 1n }),
    });
    const out = await runOnce(api, base);
    expect(out[0]).toMatchObject({ result: "failed" });
  });

  it("returns an empty list when no vault has a policy", async () => {
    const api = mockChain({ policyEmitters: async () => [] });
    expect(await runOnce(api, base)).toEqual([]);
  });

  it("does not trust a spoofed emitter that is not a factory vault", async () => {
    const api = mockChain({ createdVaults: async () => [V1], policyEmitters: async () => [SPOOF] });
    expect(await runOnce(api, base)).toEqual([]);
    expect(api.sent).toEqual([]);
  });
});
