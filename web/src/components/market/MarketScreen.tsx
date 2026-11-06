"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSignTypedData } from "wagmi";
import { erc20Abi } from "@/abi/mezo";
import { trozuMarketAbi } from "@/abi/trozu";
import { wave2 } from "@/config/wave2";
import { config, explorerAddress } from "@/config";
import { formatBps, formatBtc, formatIcr, formatMusd, shortAddress } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { approvalFor } from "@/lib/manage";
import { defaultBounds, explainRevert, feeOn, isDutch, priceAt, priceCap, stateText, type Bounds } from "@/lib/market";
import { pressPulse } from "@/lib/motion";
import { PERMIT_TYPES, PERMIT_WINDOW_SECONDS, domainMatches, permitDomain, permitMessage, splitSignature } from "@/lib/permit";
import { assertFresh } from "@/lib/rpc";
import { riskOf } from "@/lib/risk";
import { usePreflight } from "@/hooks/usePreflight";
import { useMarket, type MarketRow } from "@/hooks/useMarket";
import { useTx } from "@/hooks/useTx";
import { EmptyState, Skeleton } from "../States";
import { Tip } from "../Tip";
import { TxStatus } from "../TxStatus";
import { DutchChart } from "./DutchChart";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

function useNow(everyMs = 15_000) {
  const [n, setN] = useState(nowSec());
  useEffect(() => {
    const t = setInterval(() => setN(nowSec()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return n;
}

/** Browse open listings and buy one, plus the signed-in seller's own listings with cancel. */
export function MarketScreen() {
  const { address } = useAccount();
  const q = useMarket();
  const now = useNow();
  const [view, setView] = useState<"browse" | "mine">("browse");

  const rows = q.data?.rows ?? [];
  const open = useMemo(() => rows.filter((r) => r.state === "Ok").sort((a, b) => Number(priceAt(a.listing, now) - priceAt(b.listing, now))), [rows, now]);
  const mine = useMemo(() => rows.filter((r) => address && r.listing.seller.toLowerCase() === address.toLowerCase()), [rows, address]);
  const stale = !!q.data?.freshness.stale;

  return (
    <section className="grid-stack" aria-label="Market">
      <div className="subnav" role="tablist" aria-label="Market views">
        <button role="tab" aria-selected={view === "browse"} className={`tab${view === "browse" ? " on" : ""}`} onClick={() => setView("browse")}>
          Browse{q.data ? ` (${open.length})` : ""}
        </button>
        <button role="tab" aria-selected={view === "mine"} className={`tab${view === "mine" ? " on" : ""}`} onClick={() => setView("mine")}>
          Your listings{address && q.data ? ` (${mine.length})` : ""}
        </button>
      </div>

      {stale && (
        <p className="banner warn" role="alert">
          The node that answered is behind the chain, so this list may be missing newer listings or show sold ones. Buying is
          disabled until a current node answers.{" "}
          <button className="link" onClick={() => void q.refetch()}>Check again</button>
        </p>
      )}

      {q.isPending && (
        <div className="listing-grid" aria-label="Loading listings">
          <Skeleton height={260} />
          <Skeleton height={260} />
        </div>
      )}
      {q.isError && (
        <div className="glass state state-error" role="alert">
          <h3>Could not load the market</h3>
          <p>Listings are read from the chain&apos;s event log. The RPC or the market contract did not answer. Nothing was changed.</p>
          <code className="err-detail">{String((q.error as Error)?.message ?? q.error).split("\n")[0].slice(0, 200)}</code>
          <button className="btn" onClick={() => void q.refetch()}>Try again</button>
        </div>
      )}

      {q.data && view === "browse" && (
        <>
          {open.length === 0 ? (
            <EmptyState
              title="Nothing for sale right now"
              body="Listings appear here once a holder signs one and publishes it. List your own from any Trozu position."
            />
          ) : (
            <div className="listing-grid">
              {open.map((r) => (
                <ListingCard key={r.hash} row={r} feeBps={q.data.feeBps} now={now} stale={stale} onBought={() => void q.refetch()} />
              ))}
            </div>
          )}
          <p className="note">
            The list is rebuilt from the market&apos;s event log, read in windows from block {q.data.fromBlock.toString()} to{" "}
            {q.data.scannedTo.toString()}, so no server sits between you and the chain. Every row is checked on chain, and the
            buy is simulated again before your wallet opens.
          </p>
        </>
      )}

      {q.data && view === "mine" && (
        <MyListings rows={mine} signedIn={!!address} now={now} onChanged={() => void q.refetch()} />
      )}
    </section>
  );
}

function PositionFacts({ row }: { row: MarketRow }) {
  const i = row.info;
  if (!i) return <p className="note warn">The position details could not be read.</p>;
  const risk = riskOf(i.icr, i.active);
  return (
    <dl className="stats">
      <div><dt>Collateral</dt><dd className="mono">{formatBtc(i.coll)} <small>BTC</small></dd></div>
      <div><dt>Debt</dt><dd className="mono">{formatMusd(i.debt)} <small>MUSD</small></dd></div>
      <div><dt>Ratio<Tip term="icr" label="the collateral ratio" /></dt><dd className="mono">{i.priceOk ? formatIcr(i.icr) : "—"} <small>{i.priceOk ? risk.label : ""}</small></dd></div>
      <div><dt>Locked rate<Tip term="lockedRate" label="the locked rate" /></dt><dd className="mono">{formatBps(i.lockedRateBps)}</dd></div>
      {(row.reserveBtc > 0n || row.reserveMusd > 0n) && (
        <div className="wide"><dt>Guardian reserve included</dt><dd className="mono">{formatBtc(row.reserveBtc)} BTC · {formatMusd(row.reserveMusd)} MUSD</dd></div>
      )}
    </dl>
  );
}

export function ListingCard({ row, feeBps, now, stale, onBought }: { row: MarketRow; feeBps: number; now: bigint; stale: boolean; onBought: () => void }) {
  const l = row.listing;
  const price = priceAt(l, now);
  const [buying, setBuying] = useState(false);
  const equity = row.info && row.info.priceOk ? row.info.equity : undefined;
  return (
    <article className="glass card">
      <header className="card-head">
        <div>
          <h3>Position #{l.tokenId.toString()}</h3>
          <a className="addr" href={explorerAddress(l.seller)} target="_blank" rel="noreferrer">seller {shortAddress(l.seller)}</a>
        </div>
        <span className="chip chip-safe">{isDutch(l) ? "Dutch auction" : "Fixed price"}</span>
      </header>
      <p className="price-big">{formatMusd(price)} <small>MUSD</small></p>
      {equity !== undefined && <p className="note">Equity in the position is ${formatMusd(equity)}, shown to compare with the price.</p>}
      <DutchChart listing={l} nowSeconds={now} />
      <PositionFacts row={row} />
      {buying ? (
        <BuyPanel row={row} feeBps={feeBps} stale={stale} onCancel={() => setBuying(false)} onBought={onBought} />
      ) : (
        <div className="actions">
          <button className="btn" disabled={stale} onClick={(e) => { pressPulse(e.currentTarget); setBuying(true); }}>Buy</button>
        </div>
      )}
    </article>
  );
}

function BuyPanel({ row, feeBps, stale, onCancel, onBought }: { row: MarketRow; feeBps: number; stale: boolean; onCancel: () => void; onBought: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });
  const { signTypedDataAsync } = useSignTypedData();
  const qc = useQueryClient();
  const tx = useTx();
  const approveTx = useTx();
  const l = row.listing;
  const now = useNow(5_000);
  const pre = usePreflight(wave2.market, address, undefined, false);
  const data = pre.data?.data;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const price = priceAt(l, now);
  const cap = priceCap(l, now);
  const fee = feeOn(price, feeBps);
  const info = row.info;
  const bounds: Bounds | undefined = info
    ? defaultBounds({ epoch: l.epoch, coll: info.coll, debt: info.debt, rateBps: info.lockedRateBps, reserveBtc: row.reserveBtc, reserveMusd: row.reserveMusd }, cap)
    : undefined;

  const problems: string[] = [];
  if (!address) problems.push("Connect a wallet to buy.");
  if (!info) problems.push("The position could not be read, so the bounds cannot be set.");
  if (data && data.musd < cap) problems.push(`You hold ${formatMusd(data.musd)} MUSD and this can cost up to ${formatMusd(cap)}.`);
  if (pre.data?.freshness.stale || stale) problems.push("The node is behind the chain. Wait for it to catch up.");
  const done = tx.state.status === "success";

  const run = async () => {
    if (!client || !address || !data || !bounds) return;
    setErr(undefined);
    setBusy(true);
    try {
      await assertFresh();
      const domain = { name: data.permit.name, chainId: config.chainId, verifyingContract: config.mezo.musd };
      const how = approvalFor(cap, data.allowance, domainMatches(domain, data.permit.separator));
      let permit = { deadline: 0n, v: 0, r: "0x" as `0x${string}`, s: "0x" as `0x${string}` };
      if (how === "permit") {
        // the market asks the token for exactly maxPrice, so that is the value that gets signed
        const deadline = nowSec() + PERMIT_WINDOW_SECONDS;
        const sig = await signTypedDataAsync({
          domain: permitDomain(domain),
          types: PERMIT_TYPES,
          primaryType: "Permit",
          message: permitMessage({ owner: address, spender: wave2.market, value: bounds.maxPrice, nonce: data.permit.nonce, deadline }),
        });
        permit = { deadline, ...splitSignature(sig) };
      } else if (how === "approve") {
        const r = await approveTx.send({ address: config.mezo.musd, abi: erc20Abi, functionName: "approve", args: [wave2.market, cap], chainId: config.chainId });
        if (!r) return;
      }
      const params = {
        address: wave2.market,
        abi: trozuMarketAbi,
        functionName: "buy",
        args: [l, row.signature, bounds, address, permit],
        chainId: config.chainId,
      } as const;
      await client.simulateContract({ ...params, account: address } as never);
      setBusy(false);
      const receipt = await tx.send(params);
      if (receipt) {
        void qc.invalidateQueries({ queryKey: ["preflight"] });
        void qc.invalidateQueries({ queryKey: ["positions"] });
        onBought();
      }
    } catch (e) {
      setErr(explainRevert(e) ?? friendlyError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review" role="dialog" aria-label={`Buy position ${l.tokenId}`}>
      <h4>Check before you buy</h4>
      <dl className="preview">
        <div><dt>You pay up to</dt><dd className="mono">{formatMusd(cap)} MUSD</dd></div>
        <div><dt>Price now</dt><dd className="mono">{formatMusd(price)} MUSD</dd></div>
        <div><dt>Market fee</dt><dd className="mono">{formatMusd(fee)} MUSD</dd></div>
        <div><dt>Seller gets</dt><dd className="mono">{formatMusd(price - fee)} MUSD</dd></div>
      </dl>
      {bounds && (
        <>
          <p className="note">
            The sale only goes through if, at the moment it settles, the position still has at least{" "}
            <b className="mono">{formatBtc(bounds.minColl)} BTC</b> of collateral, owes at most{" "}
            <b className="mono">{formatMusd(bounds.maxDebt)} MUSD</b>, keeps its {formatBps(bounds.minRateBps)} locked rate, and still
            holds the guardian reserve you saw. If anything changed, the transaction reverts and you pay nothing but gas.
          </p>
          <p className="note">You pay no more than {formatMusd(bounds.maxPrice)} MUSD. The position and its reserve go to your wallet.</p>
        </>
      )}
      {data && bounds && (
        <p className="note">
          {approvalFor(cap, data.allowance, domainMatches({ name: data.permit.name, chainId: config.chainId, verifyingContract: config.mezo.musd }, data.permit.separator)) === "allowance"
            ? "The market already has enough MUSD allowance."
            : <>You will sign a permit for the price cap. It costs no gas and lasts ten minutes.<Tip term="permit" label="a permit" /></>}
        </p>
      )}
      {pre.isError && <p className="banner warn" role="alert">Could not read your balance. <button className="link" onClick={() => void pre.refetch()}>Try again</button></p>}
      {problems.map((m) => <p key={m} className="note warn" role="alert">{m}</p>)}
      {err && <p className="note warn" role="alert">{err}</p>}
      <TxStatus state={tx.state.status === "idle" && approveTx.state.status !== "idle" ? approveTx.state : tx.state} successText="The position is yours." />
      {!done && (
        <div className="actions">
          <button className="btn btn-quiet" disabled={busy || tx.busy} onClick={onCancel}>Back</button>
          <button className="btn" disabled={busy || tx.busy || approveTx.busy || problems.length > 0 || !data} onClick={(e) => { pressPulse(e.currentTarget); void run(); }}>
            {busy ? "Checking…" : tx.state.status === "failed" ? "Try again" : "Buy position"}
          </button>
        </div>
      )}
    </div>
  );
}

function MyListings({ rows, signedIn, now, onChanged }: { rows: MarketRow[]; signedIn: boolean; now: bigint; onChanged: () => void }) {
  const client = usePublicClient({ chainId: config.chainId });
  const { address } = useAccount();
  const tx = useTx();
  const [err, setErr] = useState<string | undefined>();
  const [busyHash, setBusyHash] = useState<string | undefined>();

  if (!signedIn) return <EmptyState title="Connect a wallet" body="Your listings show up here once you are connected." />;

  const send = async (key: string, fn: "cancel" | "cancelAll", args: readonly unknown[]) => {
    if (!client || !address) return;
    setErr(undefined);
    setBusyHash(key);
    try {
      await assertFresh();
      const params = { address: wave2.market, abi: trozuMarketAbi, functionName: fn, args, chainId: config.chainId } as const;
      await client.simulateContract({ ...params, account: address } as never);
      const r = await tx.send(params);
      if (r) onChanged();
    } catch (e) {
      setErr(explainRevert(e) ?? friendlyError(e).message);
    } finally {
      setBusyHash(undefined);
    }
  };

  const live = rows.filter((r) => r.state !== "Filled" && r.state !== "Cancelled");
  return (
    <section className="glass panel" aria-label="Your listings">
      <header className="panel-head">
        <h2>Your listings</h2>
        <p>A listing is a signature, and the position stays in your wallet until someone buys it. Cancelling is a transaction.</p>
      </header>
      {rows.length === 0 && <EmptyState title="You have no listings" body="Open one of your Trozu positions and choose Sell to list it." />}
      {rows.map((r) => (
        <div key={r.hash} className="block">
          <h4>Position #{r.listing.tokenId.toString()} · {formatMusd(priceAt(r.listing, now))} MUSD{isDutch(r.listing) ? " now" : ""}</h4>
          <p className={`note ${r.state === "Ok" ? "good" : "warn"}`}>{stateText(r.state)}</p>
          {r.state !== "Filled" && r.state !== "Cancelled" && (
            <button className="btn btn-quiet btn-small" disabled={!!busyHash || tx.busy} onClick={() => void send(r.hash, "cancel", [r.listing])}>
              {busyHash === r.hash ? "Checking…" : "Cancel this listing"}
            </button>
          )}
        </div>
      ))}
      {live.length > 1 && (
        <div className="block">
          <h4>Cancel everything</h4>
          <p className="note">One transaction voids every listing you have signed so far, including ones not listed here.</p>
          <button className="btn btn-quiet btn-small" disabled={!!busyHash || tx.busy} onClick={() => void send("all", "cancelAll", [])}>
            Cancel all my listings
          </button>
        </div>
      )}
      {err && <p className="note warn" role="alert">{err}</p>}
      <TxStatus state={tx.state} successText="Done. The listing can no longer be bought." />
    </section>
  );
}
