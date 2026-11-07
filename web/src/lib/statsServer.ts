import { createPublicClient, type AbiEvent, type Log } from "viem";
import { trozuFactoryAbi, trozuMarketAbi, trozuVaultAbi } from "@/abi/trozu";
import { LOG_WINDOW, wave2 } from "@/config/wave2";
import { teamSet } from "@/config/team";
import { createTracker } from "./freshness";
import { mezoTestnetChain, makeTransport } from "./rpc";
import type { StatLog } from "./stats";
import { StatsError, buildSnapshot, type ScanState, type StatsChain, type StatsSnapshot } from "./statsSnapshot";

type Hex = `0x${string}`;

const event = (abi: readonly unknown[], name: string) => (abi as readonly AbiEvent[]).find((x) => x.type === "event" && x.name === name)!;
const created = event(trozuFactoryAbi, "PositionCreated");
const marketEvents = ["ListingAnnounced", "ListingCancelled", "AllListingsCancelled", "Sold"].map((n) => event(trozuMarketAbi, n));
const vaultEvents = ["PolicySet", "PolicyCleared", "GuardianAction"].map((n) => event(trozuVaultAbi, n));

// Calls made in the same tick leave as one HTTP request, so a head block and the logs it is paired with come from one node.
const client = createPublicClient({ chain: mezoTestnetChain, transport: makeTransport(true) });
const tracker = createTracker();

const toStat = (l: Log): StatLog => {
  const x = l as unknown as { eventName: string; address: Hex; blockNumber: bigint; logIndex: number; args: Record<string, unknown> };
  return { eventName: x.eventName, address: x.address, blockNumber: x.blockNumber, logIndex: x.logIndex, args: x.args ?? {} };
};

const chain: StatsChain = {
  async head() {
    const b = await client.getBlock({ blockTag: "latest" });
    return { number: b.number, timestamp: b.timestamp };
  },
  async window(from, to) {
    const [nodeHead, f, m, v] = await Promise.all([
      client.getBlockNumber(),
      client.getLogs({ address: wave2.factory, event: created as never, fromBlock: from, toBlock: to }),
      client.getLogs({ address: wave2.market, events: marketEvents as never, fromBlock: from, toBlock: to }),
      // no address: anyone can emit these topics, and the tally keeps only factory-created vaults
      client.getLogs({ events: vaultEvents as never, fromBlock: from, toBlock: to }),
    ]);
    return { nodeHead, factory: (f as Log[]).map(toStat), market: (m as Log[]).map(toStat), vaults: (v as Log[]).map(toStat) };
  },
  async checkListing(c) {
    return Number(
      await client.readContract({ address: wave2.market, abi: trozuMarketAbi, functionName: "check", args: [c.listing, c.signature] as never }),
    );
  },
  async preview(vault) {
    const p = (await client.readContract({ address: vault, abi: trozuVaultAbi, functionName: "preview" })) as { kind: number; reason: number };
    return { kind: Number(p.kind), reason: Number(p.reason) };
  },
};

/** At most about 34 days of testnet blocks per scan (5.5 s blocks). Older history is dropped and the page says so. */
export const MAX_SCAN_BLOCKS = 60n * LOG_WINDOW;

let scanState: ScanState | undefined;
let lastGood: StatsSnapshot | undefined;

async function compute(): Promise<StatsSnapshot> {
  const r = await buildSnapshot(chain, scanState, {
    deployBlock: wave2.deployBlock,
    maxBlocks: MAX_SCAN_BLOCKS,
    windowSize: LOG_WINDOW,
    budgetMs: 6_000,
    maxChecks: 40,
    maxPreviews: 25,
    team: teamSet(),
    tracker,
  });
  scanState = r.state;
  lastGood = r.snapshot;
  return r.snapshot;
}

// One read at a time, kept for a minute. A read that stopped early is kept for only a few seconds, so the next load continues it.
const TTL_MS = 60_000;
const TTL_PARTIAL_MS = 5_000;
let memo: { at: number; snapshot: StatsSnapshot } | undefined;
let inflight: Promise<StatsSnapshot> | undefined;

async function cached(): Promise<StatsSnapshot> {
  if (memo && Date.now() - memo.at < (memo.snapshot.range.complete ? TTL_MS : TTL_PARTIAL_MS)) return memo.snapshot;
  inflight ??= compute()
    .then((snapshot) => {
      memo = { at: Date.now(), snapshot };
      return snapshot;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

export type StatsResult =
  | { ok: true; snapshot: StatsSnapshot }
  | { ok: false; error: string };

/**
 * The numbers for the stats page and the API.  If the chain cannot be read, an older snapshot
 * from this server's memory stands in, marked `degraded`; with none, the result is an error and nothing is invented.
 */
export async function getStats(): Promise<StatsResult> {
  try {
    return { ok: true, snapshot: await cached() };
  } catch (e) {
    const why = e instanceof StatsError ? e.message : "The RPC could not be read.";
    if (lastGood) return { ok: true, snapshot: { ...lastGood, degraded: `${why} These are the numbers from the last successful read.` } };
    return { ok: false, error: why };
  }
}
