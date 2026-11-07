"use client";

import { useEffect, useRef } from "react";
import { enterStaggered } from "@/lib/motion";
import { formatBtc, formatMusd, toNumber } from "@/lib/format";
import { ageText } from "@/lib/stats";
import type { StatsSnapshot } from "@/lib/statsSnapshot";
import { CountUp } from "../CountUp";

const int = (n: number) => Math.round(n).toLocaleString("en-US");
const musd = (n: number) => (Math.floor(n * 100 + 1e-6) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Tile({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <b className="big">{children}</b>
      {hint && <small className="note">{hint}</small>}
    </div>
  );
}

/** The numbers of one snapshot, with every cap and warning that applies to it written out next to them. */
export function StatsView({ s }: { s: StatsSnapshot }) {
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (grid.current) enterStaggered(grid.current.querySelectorAll(".tile"), 45);
  }, []);

  const volume = BigInt(s.sales.volumeWei);
  const fees = BigInt(s.sales.feesWei);
  const tips = BigInt(s.keeper.tipsWei);
  const k = s.keeper.byKind;
  const holds = Object.entries(s.planner.holds).sort((a, b) => b[1] - a[1]);
  const updated = new Date(s.generatedAt);

  return (
    <div className="grid-stack" ref={grid}>
      {s.stale && (
        <div className="banner warn" role="alert">
          <span>The node that answered looks out of date. {s.staleReason} The numbers may be missing recent events.</span>
        </div>
      )}
      {s.degraded && (
        <div className="banner warn" role="alert">
          <span>{s.degraded}</span>
        </div>
      )}
      {s.range.truncated && (
        <div className="banner warn" role="status">
          <span>
            Only the most recent {Number(s.range.maxBlocks).toLocaleString("en-US")} blocks are read, so every count here is
            since block {Number(s.range.fromBlock).toLocaleString("en-US")}, not since launch.
          </span>
        </div>
      )}
      {!s.range.complete && (
        <div className="banner warn" role="status">
          <span>The read stopped early to stay within its time limit, so the counts cover blocks up to {Number(s.asOfBlock).toLocaleString("en-US")} and will catch up on the next load.</span>
        </div>
      )}

      <p className="note" data-testid="updated">
        Last updated <time dateTime={s.generatedAt}>{updated.toISOString().replace("T", " ").slice(0, 19)} UTC</time>. Counts include
        blocks {Number(s.range.fromBlock).toLocaleString("en-US")} to {Number(s.asOfBlock).toLocaleString("en-US")}; the node&apos;s newest
        block was {ageText(s.head.ageSeconds)} old. Cached for about a minute.
      </p>

      <section className="glass panel" aria-label="Positions and market">
        <header className="panel-head"><h2>Positions and market</h2></header>
        <div className="tiles">
          <Tile label="Positions created"><CountUp value={s.positionsCreated} format={int} /></Tile>
          <Tile label="Active listings" hint={s.activeListings.exact ? "Checked with the market" : "Not exact"}>
            <CountUp value={s.activeListings.count} format={int} />
          </Tile>
          <Tile label="Sales"><CountUp value={s.sales.count} format={int} /></Tile>
          <Tile label="Sale volume" hint="MUSD"><CountUp value={toNumber(volume)} format={musd} /></Tile>
          <Tile label="Fee collected" hint="MUSD, the market fee on sales"><CountUp value={toNumber(fees)} format={musd} /></Tile>
          <Tile label="Listings ever"><CountUp value={s.listings.announced} format={int} /></Tile>
        </div>
        <p className="note">{s.activeListings.note}</p>
        <p className="note">
          Of {s.listings.announced} announced: {s.listings.sold} sold, {s.listings.cancelled} cancelled, {s.listings.revoked} cancelled in
          bulk, {s.listings.expired} expired. Volume is {formatMusd(volume)} MUSD and fees are {formatMusd(fees)} MUSD, summed from
          the market&apos;s <code>Sold</code> events.
        </p>
      </section>

      <section className="glass panel" aria-label="Guardian and keepers">
        <header className="panel-head"><h2>Guardian and keepers</h2></header>
        <div className="tiles">
          <Tile label="Guardian policies" hint="set and not cleared"><CountUp value={s.policies.set} format={int} /></Tile>
          <Tile label="Keeper actions"><CountUp value={s.keeper.actions} format={int} /></Tile>
          <Tile label="Keepers"><CountUp value={s.keeper.keepers} format={int} /></Tile>
          <Tile label="Tips paid" hint="BTC"><span className="mono">{formatBtc(tips)}</span></Tile>
        </div>
        <p className="note">
          Actions by kind: {k.TopUpBtc} BTC top-ups, {k.RepayMusd} MUSD repayments, {k.DefendBtc} redemption defenses
          {k.other > 0 ? `, ${k.other} unrecognised` : ""}.
        </p>
      </section>

      <section className="glass panel" aria-label="Refusals">
        <header className="panel-head"><h2>What the guardians would do now</h2></header>
        <p className="note">
          A refused <code>execute</code> call reverts and leaves no event, so refusals in the past cannot be counted from logs. This is the
          vault&apos;s own planner asked about {s.planner.sampled} of {s.planner.total} policies right now.
        </p>
        {s.planner.sampled === 0 ? (
          <p className="note">No policies to ask about.</p>
        ) : (
          <ul className="evidence">
            <li><b className="mono">{s.planner.wouldAct}</b> would act</li>
            {holds.map(([reason, n]) => (
              <li key={reason}><b className="mono">{n}</b> hold: {reason}</li>
            ))}
            {s.planner.unreadable > 0 && <li><b className="mono">{s.planner.unreadable}</b> could not be read</li>}
          </ul>
        )}
        {s.planner.total > s.planner.sampled && <p className="note">Only the first {s.planner.sampled} policies are asked, to keep the read small.</p>}
      </section>

      <section className="glass panel" aria-label="How this is counted">
        <header className="panel-head"><h2>How this is counted</h2></header>
        <ul className="evidence">
          <li>Positions: <code>PositionCreated</code> events of the factory.</li>
          <li>Listings and sales: the market&apos;s <code>ListingAnnounced</code>, <code>ListingCancelled</code>, <code>AllListingsCancelled</code> and <code>Sold</code> events.</li>
          <li>Policies and keeper actions: <code>PolicySet</code>, <code>PolicyCleared</code> and <code>GuardianAction</code>, only from vaults the factory created
            {s.ignoredVaultLogs > 0 ? ` (${s.ignoredVaultLogs} from other addresses were ignored)` : ""}.</li>
          <li>Logs are read in windows of 9,000 blocks because the public RPC refuses more.</li>
        </ul>
      </section>
    </div>
  );
}
