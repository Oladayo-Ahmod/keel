import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";
import { config } from "@/config";
import { MAX_ATTEMPTS, assess, createTracker, readFresh, type Freshness, type FreshRead, type Head } from "./freshness";

export const mezoTestnetChain = defineChain({
  id: config.chainId,
  name: config.name,
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: config.rpcUrls } },
  blockExplorers: { default: { name: "Mezo Explorer", url: config.explorer } },
});

/** Each endpoint retries dropped connections; the list is tried in order. */
export function makeTransport(batch = false) {
  const each = config.rpcUrls.map((url) =>
    http(url, { retryCount: 3, retryDelay: 600, timeout: 15_000, ...(batch ? { batch: { wait: 8 } } : {}) }),
  );
  return each.length > 1 ? fallback(each, { retryCount: 2 }) : each[0];
}

// Calls made in the same tick go out as one HTTP request, so a head block and the data it
// is paired with come from the same node.
const client: PublicClient = createPublicClient({ chain: mezoTestnetChain, transport: makeTransport(true) });

export const tracker = createTracker();

export class StaleNodeError extends Error {
  constructor(public freshness: Freshness) {
    super(freshness.reason ?? "The RPC node looks out of date.");
    this.name = "StaleNodeError";
  }
}

async function headOf(c: PublicClient): Promise<Head> {
  const b = await c.getBlock({ blockTag: "latest" });
  return { number: b.number, timestamp: b.timestamp };
}

/** Runs reads against the shared client together with a head read, retrying stale answers. */
export function freshRead<T>(run: (c: PublicClient) => Promise<T>): Promise<FreshRead<T>> {
  return readFresh({
    tracker,
    read: async () => {
      const [head, data] = await Promise.all([headOf(client), run(client)]);
      return { head, data };
    },
  });
}

/** Just the head, for the status pill and for the check right before a transaction. */
export async function currentFreshness(): Promise<Freshness> {
  const r = await readFresh({ tracker, read: async () => ({ head: await headOf(client), data: null }) });
  return r.freshness;
}

/** Throws if the node cannot be shown to be current. Called before simulating or sending anything. */
export async function assertFresh(): Promise<Freshness> {
  const f = await currentFreshness();
  if (f.stale) throw new StaleNodeError(f);
  return f;
}

/** The worse of two freshness results, for reads that take two steps. */
export function worst(a: Freshness, b: Freshness): Freshness {
  if (a.stale) return a;
  if (b.stale) return b;
  return a.blockNumber < b.blockNumber ? a : b;
}

export { assess, MAX_ATTEMPTS };
