type Hex = `0x${string}`;

/** A decoded log, reduced to what the tally needs. The loader fills it from viem's getLogs. */
export interface StatLog {
  eventName: string;
  address: Hex;
  blockNumber: bigint;
  logIndex: number;
  args: Record<string, unknown>;
}

export interface OpenCandidate {
  hash: Hex;
  seller: Hex;
  tokenId: bigint;
  deadline: bigint;
  nonce: bigint;
  listing: unknown;
  signature: Hex;
}

export interface Tally {
  positionsCreated: number;
  listings: {
    announced: number;
    sold: number;
    cancelled: number;
    /** Past their deadline and never sold or cancelled. */
    expired: number;
    /** Cancelled in bulk by raising the seller's nonce. */
    revoked: number;
    /** Announced and none of the above. The market can still refuse one for other reasons, see `check`. */
    openByLogs: number;
    candidates: OpenCandidate[];
  };
  sales: { count: number; volume: bigint; fees: bigint };
  policies: { set: number; vaultsWithHistory: number; vaults: Hex[] };
  keeper: {
    actions: number;
    byKind: { TopUpBtc: number; RepayMusd: number; DefendBtc: number; other: number };
    tips: bigint;
    keepers: number;
  };
  /** Logs from addresses that are not factory vaults and so were ignored. Anyone can emit these topics. */
  ignoredVaultLogs: number;
}

const lower = (a: unknown) => String(a).toLowerCase();
const order = (a: StatLog, b: StatLog) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);

/** Kind enum of the vault, as emitted in GuardianAction. */
const KIND = ["other", "TopUpBtc", "RepayMusd", "DefendBtc"] as const;

/**
 * Turns the logs of the factory, the market and the vaults into counts. It is pure, so the page's numbers can be
 * checked against a fixture. Vault events are only trusted from addresses the factory created, because anything can
 * emit a `PolicySet` or `GuardianAction` topic.
 */
export function tally(input: { factory: StatLog[]; market: StatLog[]; vaults: StatLog[]; nowSeconds: bigint }): Tally {
  const created = new Map<string, Hex>();
  for (const l of input.factory) {
    if (l.eventName !== "PositionCreated") continue;
    created.set(lower(l.args.vault), l.args.vault as Hex);
  }

  // market
  const announced = new Map<string, OpenCandidate>();
  const sold = new Set<string>();
  const cancelled = new Set<string>();
  const revokedBelow = new Map<string, bigint>();
  let salesCount = 0;
  let volume = 0n;
  let fees = 0n;
  for (const l of [...input.market].sort(order)) {
    const a = l.args;
    switch (l.eventName) {
      case "ListingAnnounced": {
        const listing = a.listing as { nonce: bigint; deadline: bigint; seller: Hex; tokenId: bigint };
        announced.set(lower(a.hash), {
          hash: a.hash as Hex, seller: a.seller as Hex, tokenId: a.tokenId as bigint,
          deadline: listing.deadline, nonce: listing.nonce, listing, signature: a.signature as Hex,
        });
        break;
      }
      case "ListingCancelled":
        cancelled.add(lower(a.hash));
        break;
      case "AllListingsCancelled": {
        const s = lower(a.seller);
        const n = a.newNonce as bigint;
        if (n > (revokedBelow.get(s) ?? 0n)) revokedBelow.set(s, n);
        break;
      }
      case "Sold":
        salesCount++;
        sold.add(lower(a.hash));
        volume += a.price as bigint;
        fees += a.fee as bigint;
        break;
    }
  }
  let nSold = 0, nCancelled = 0, nExpired = 0, nRevoked = 0;
  const candidates: OpenCandidate[] = [];
  for (const [key, c] of announced) {
    // one reason each, in the order the market checks them
    if (sold.has(key)) nSold++;
    else if (cancelled.has(key)) nCancelled++;
    else if (c.nonce < (revokedBelow.get(lower(c.seller)) ?? 0n)) nRevoked++;
    else if (c.deadline <= input.nowSeconds) nExpired++;
    else candidates.push(c);
  }

  // vaults: policies and keeper actions
  const state = new Map<string, boolean>();
  const keepers = new Set<string>();
  const byKind = { TopUpBtc: 0, RepayMusd: 0, DefendBtc: 0, other: 0 };
  let actions = 0;
  let tips = 0n;
  let ignored = 0;
  for (const l of [...input.vaults].sort(order)) {
    const v = lower(l.address);
    if (!created.has(v)) {
      ignored++;
      continue;
    }
    if (l.eventName === "PolicySet") state.set(v, true);
    else if (l.eventName === "PolicyCleared") state.set(v, false);
    else if (l.eventName === "GuardianAction") {
      actions++;
      tips += l.args.tip as bigint;
      keepers.add(lower(l.args.keeper));
      byKind[KIND[Number(l.args.kind)] ?? "other"]++;
    }
  }
  const live = [...state].filter(([, on]) => on).map(([v]) => created.get(v)!);

  return {
    positionsCreated: created.size,
    listings: {
      announced: announced.size, sold: nSold, cancelled: nCancelled, expired: nExpired, revoked: nRevoked,
      openByLogs: candidates.length, candidates,
    },
    sales: { count: salesCount, volume, fees },
    policies: { set: live.length, vaultsWithHistory: state.size, vaults: live },
    keeper: { actions, byKind, tips, keepers: keepers.size },
    ignoredVaultLogs: ignored,
  };
}

/** Block windows of at most `size`, from `from` to `to` inclusive. */
export function windows(from: bigint, to: bigint, size: bigint): Array<[bigint, bigint]> {
  const out: Array<[bigint, bigint]> = [];
  for (let lo = from; lo <= to; lo += size) out.push([lo, lo + size - 1n > to ? to : lo + size - 1n]);
  return out;
}

/**
 * The first block to read. A scan reads at most `maxBlocks`; when the chain is older than that the start moves up
 * and the result must say its counts are "since block N", not all time.
 */
export function scanStart(deployBlock: bigint, head: bigint, maxBlocks: bigint): { from: bigint; truncated: boolean } {
  if (head < deployBlock) return { from: deployBlock, truncated: false };
  const span = head - deployBlock + 1n;
  if (span <= maxBlocks) return { from: deployBlock, truncated: false };
  return { from: head - maxBlocks + 1n, truncated: true };
}

/** One line on how fresh a snapshot is, by the clock of the head block it was read at. */
export function ageText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}
