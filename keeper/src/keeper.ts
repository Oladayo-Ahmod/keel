import { ChainApi, ChainRevert, Hex, KIND_NAMES, Kind, Plan, REASON_NAMES, SendResult } from "./types.js";

export interface KeeperOptions {
  /// First block to scan, normally the factory's deployment block.
  fromBlock: bigint;
  dryRun: boolean;
  /// The public RPC refuses log ranges over 10,000 blocks.
  windowSize?: bigint;
  /// Gas estimate times this over 100, for headroom against state drift between estimate and inclusion.
  gasBufferPct?: bigint;
  /// Never send with less than this. On Mezo testnet the node once answered eth_estimateGas for
  /// execute() with about 21,300, while the call really needs about 5.6M, and the transaction ran
  /// out of gas. Mezo charges at least half of the gas limit (checked 2026-11-07: a plain self-send with a 1M limit was charged 500,000 gas), so a generous limit is cheap, not free: 6M costs about 3M gas, under 0.000000001 BTC at the 292 wei seen.
  gasFloor?: bigint;
  /// Never ask for more than this; the chain's block limit is 10M.
  gasCap?: bigint;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type Outcome =
  | { vault: Hex; result: "skipped"; why: string }
  | { vault: Hex; result: "would-send"; kind: string; amount: bigint; tip: bigint; gas: bigint }
  | { vault: Hex; result: "sent"; kind: string; amount: bigint; tip: bigint; tx: Hex; gasUsed: bigint }
  | { vault: Hex; result: "failed"; why: string };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/// Retry transient errors with exponential backoff. A contract revert is an answer, not a
/// transient failure, so it goes straight back to the caller.
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts: number; baseDelayMs: number; sleep: (ms: number) => Promise<void> },
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ChainRevert) throw e;
      last = e;
      if (attempt < opts.maxAttempts - 1) await opts.sleep(opts.baseDelayMs * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/// Windows [from, to] of at most `size` blocks.
export function windows(from: bigint, to: bigint, size: bigint): Array<[bigint, bigint]> {
  const out: Array<[bigint, bigint]> = [];
  for (let lo = from; lo <= to; lo += size) out.push([lo, lo + size - 1n > to ? to : lo + size - 1n]);
  return out;
}

/// Vaults that have a policy event and were really created by the factory.
export async function discover(api: ChainApi, o: Required<Pick<KeeperOptions, "fromBlock" | "windowSize" | "maxAttempts" | "baseDelayMs" | "sleep">>): Promise<Hex[]> {
  const head = await withBackoff(() => api.head(), o);
  const vaults = new Set<string>();
  const emitters = new Set<string>();
  for (const [lo, hi] of windows(o.fromBlock, head, o.windowSize)) {
    for (const v of await withBackoff(() => api.createdVaults(lo, hi), o)) vaults.add(v.toLowerCase());
    for (const e of await withBackoff(() => api.policyEmitters(lo, hi), o)) emitters.add(e.toLowerCase());
  }
  return [...emitters].filter((e) => vaults.has(e)) as Hex[];
}

/// The gas limit to send with: the buffered estimate, but never under the floor and never over the cap.
export function chooseGas(estimate: bigint, bufferPct: bigint, floor: bigint, cap: bigint): bigint {
  const buffered = (estimate * bufferPct) / 100n;
  const g = buffered > floor ? buffered : floor;
  return g > cap ? cap : g;
}

export function describe(p: Plan): string {
  return `${KIND_NAMES[p.kind] ?? p.kind} reason=${REASON_NAMES[p.reason] ?? p.reason} amount=${p.amount} tip=${p.tip} icr=${p.icr}`;
}

/// One pass: discover policy vaults, ask each vault's own planner, and send `execute` only where
/// it would act. One vault failing never stops the others.
export async function runOnce(api: ChainApi, options: KeeperOptions): Promise<Outcome[]> {
  const o = {
    fromBlock: options.fromBlock,
    windowSize: options.windowSize ?? 10_000n,
    maxAttempts: options.maxAttempts ?? 5,
    baseDelayMs: options.baseDelayMs ?? 1000,
    sleep: options.sleep ?? defaultSleep,
  };
  const gasBufferPct = options.gasBufferPct ?? 120n;
  const gasFloor = options.gasFloor ?? 6_000_000n;
  const gasCap = options.gasCap ?? 9_500_000n;
  const log = options.log ?? (() => {});
  const outcomes: Outcome[] = [];

  const vaults = await discover(api, o);
  log(`${vaults.length} vault(s) with a policy event`);

  for (const vault of vaults) {
    try {
      if (!(await withBackoff(() => api.policyLive(vault), o))) {
        outcomes.push({ vault, result: "skipped", why: "policy not live" });
        continue;
      }
      const plan = await withBackoff(() => api.preview(vault), o);
      if (plan.kind === Kind.None) {
        outcomes.push({ vault, result: "skipped", why: `planner: ${REASON_NAMES[plan.reason] ?? plan.reason}` });
        continue;
      }
      log(`${vault} planner says act: ${describe(plan)}`);

      // hints are an optimisation only: if the lookup fails, send with none
      let hints: readonly [Hex, Hex] | undefined;
      if (api.hints) {
        try {
          hints = await withBackoff(() => api.hints!(vault, plan), o);
        } catch {
          hints = undefined;
        }
      }

      let gas: bigint;
      try {
        gas = chooseGas(await withBackoff(() => api.estimateExecute(vault, hints), o), gasBufferPct, gasFloor, gasCap);
      } catch (e) {
        // the plan said act but the call would revert now (state moved, or another keeper got there first)
        if (e instanceof ChainRevert) {
          outcomes.push({ vault, result: "skipped", why: `estimate reverted: ${e.reason}` });
          continue;
        }
        throw e;
      }

      const kind = KIND_NAMES[plan.kind] ?? String(plan.kind);
      if (options.dryRun) {
        outcomes.push({ vault, result: "would-send", kind, amount: plan.amount, tip: plan.tip, gas });
        continue;
      }
      const sent: SendResult = await withBackoff(() => api.sendExecute(vault, gas, hints), o);
      if (sent.status !== "success") {
        outcomes.push({ vault, result: "failed", why: `transaction ${sent.hash} reverted` });
      } else {
        outcomes.push({ vault, result: "sent", kind, amount: plan.amount, tip: plan.tip, tx: sent.hash, gasUsed: sent.gasUsed });
      }
    } catch (e) {
      outcomes.push({ vault, result: "failed", why: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}
