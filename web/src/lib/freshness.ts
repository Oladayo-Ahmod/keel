/**
 * The public RPC sits behind a load balancer whose nodes can be far apart: on
 * 2026-10-22 two nodes answered with blocks about 214,000 apart. A read from the
 * old one looks normal but shows old state, so every read that feeds a decision
 * is paired with the head block of the node that answered it, and judged here.
 */

/** Mezo testnet makes a block about every 5.5 seconds (measured), so 12 blocks is about a minute. */
export const MAX_LAG_BLOCKS = 12n;
/** A head block older than this, by the browser clock, is treated as stale. */
export const MAX_AGE_SECONDS = 120;
export const MAX_ATTEMPTS = 4;

export interface Head {
  number: bigint;
  timestamp: bigint; // seconds
}

export interface Freshness {
  blockNumber: bigint;
  ageSeconds: number;
  stale: boolean;
  reason?: string;
}

export interface Tracker {
  /** Highest head seen from any node so far. */
  highest: Head | undefined;
  observe(h: Head): void;
}

export function createTracker(): Tracker {
  return {
    highest: undefined,
    observe(h) {
      if (!this.highest || h.number > this.highest.number) this.highest = h;
    },
  };
}

/**
 * Judges a head. It is stale when it is far behind the newest head ever seen, or when its
 * own timestamp is old. The tracker is updated first, so the first read of a session can only
 * be judged by age.
 */
export function assess(head: Head, tracker: Tracker, nowSeconds: number): Freshness {
  tracker.observe(head);
  const age = Math.max(0, nowSeconds - Number(head.timestamp));
  const highest = tracker.highest!;
  const behind = highest.number - head.number;
  if (behind > MAX_LAG_BLOCKS) {
    return {
      blockNumber: head.number,
      ageSeconds: age,
      stale: true,
      reason: `This node is ${behind.toString()} blocks behind the newest block seen (${highest.number.toString()}).`,
    };
  }
  if (age > MAX_AGE_SECONDS) {
    return {
      blockNumber: head.number,
      ageSeconds: age,
      stale: true,
      reason: `The latest block this node has is ${age} seconds old.`,
    };
  }
  return { blockNumber: head.number, ageSeconds: age, stale: false };
}

export interface FreshRead<T> {
  data: T;
  freshness: Freshness;
}

export interface ReadFreshDeps<T> {
  /** Reads the head and the data in the same round trip, so both come from the same node. */
  read: () => Promise<{ head: Head; data: T }>;
  tracker: Tracker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reads, and if the answering node looks stale tries again (the next request usually reaches
 * another node). If every attempt is stale the last answer is returned flagged, never silently.
 * A read that throws is retried the same way and rethrown after the last attempt.
 */
export async function readFresh<T>(deps: ReadFreshDeps<T>): Promise<FreshRead<T>> {
  const attempts = deps.attempts ?? MAX_ATTEMPTS;
  const now = deps.now ?? (() => Date.now() / 1000);
  const sleep = deps.sleep ?? wait;
  let last: FreshRead<T> | undefined;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const { head, data } = await deps.read();
      const freshness = assess(head, deps.tracker, now());
      last = { data, freshness };
      if (!freshness.stale) return last;
    } catch (e) {
      lastError = e;
    }
    if (i < attempts - 1) await sleep(400 * (i + 1));
  }
  if (last) return last;
  throw lastError;
}
