import { createPublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTransport } from "./rpc";

afterEach(() => vi.unstubAllGlobals());

describe("rpc transport", () => {
  it.each([false, true])("asks fetch not to cache, batched or not (%s)", async (batch) => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      seen.push(init);
      const body = JSON.parse(String(init.body));
      const reply = (r: { id: number }) => ({ jsonrpc: "2.0", id: r.id, result: "0x10" });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { "content-type": "application/json" } });
    });
    const client = createPublicClient({ transport: makeTransport(batch) });
    expect(await client.getBlockNumber()).toBe(16n);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((i) => i.cache === "no-store")).toBe(true);
  });
});

// a stub chain over fetch: answers the JSON-RPC methods the app and the stats reader use, and records how it was called
function stubChain(opts: { head: bigint; headAgeSeconds?: number; logs?: unknown[] }) {
  const seen: Array<{ method: string; cache: RequestInit["cache"] }> = [];
  const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
  const answer = (r: { id: number; method: string }) => {
    let result: unknown = "0x0";
    if (r.method === "eth_blockNumber") result = hex(opts.head);
    else if (r.method === "eth_getBlockByNumber") {
      const ts = Math.floor(Date.now() / 1000) - (opts.headAgeSeconds ?? 3);
      result = { number: hex(opts.head), hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), timestamp: hex(ts), transactions: [], gasLimit: "0x0", gasUsed: "0x0", baseFeePerGas: "0x0" };
    } else if (r.method === "eth_getLogs") result = opts.logs ?? [];
    return { jsonrpc: "2.0", id: r.id, result };
  };
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const list = Array.isArray(body) ? body : [body];
    for (const r of list) seen.push({ method: r.method, cache: init.cache });
    const out = list.map(answer);
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: { "content-type": "application/json" } });
  });
  return seen;
}

describe("the stale-node guard through the uncached transport", () => {
  it("still flags an old head, and still passes a fresh one", async () => {
    const { readFresh, createTracker } = await import("./freshness");
    const run = async (headAgeSeconds: number) => {
      stubChain({ head: 5_000n, headAgeSeconds });
      const client = createPublicClient({ transport: makeTransport(true) });
      return readFresh({
        tracker: createTracker(),
        attempts: 2,
        sleep: async () => undefined,
        read: async () => {
          const b = await client.getBlock({ blockTag: "latest" });
          return { head: { number: b.number, timestamp: b.timestamp }, data: null };
        },
      });
    };
    expect((await run(3)).freshness.stale).toBe(false);
    const old = await run(900);
    expect(old.freshness.stale).toBe(true);
    expect(old.freshness.reason).toMatch(/seconds old/);
  });
});

describe("/api/stats reads", () => {
  it("send every chain request uncached, head, block number and logs alike", async () => {
    const { wave2 } = await import("@/config/wave2");
    const seen = stubChain({ head: wave2.deployBlock + 120n });
    const { getStats } = await import("./statsServer");
    const r = await getStats();
    expect(r.ok).toBe(true);
    const methods = new Set(seen.map((s) => s.method));
    expect(methods.has("eth_getBlockByNumber")).toBe(true);
    expect(methods.has("eth_getLogs")).toBe(true);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((s) => s.cache === "no-store")).toBe(true);
  });
});
