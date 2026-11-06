"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSignTypedData } from "wagmi";
import { erc20Abi } from "@/abi/mezo";
import { trozuVaultAbi } from "@/abi/trozu";
import { config, explorerTx } from "@/config";
import { wave2 } from "@/config/wave2";
import { formatBtc, formatIcr, formatMusd, shortAddress } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import {
  KIND_LABEL,
  describePlan,
  kindName,
  parseOptional,
  parsePercent,
  policyWarnings,
  remaining,
  suggestPolicy,
  validatePolicy,
  windowFresh,
  type PolicyInput,
} from "@/lib/guardian";
import { approvalFor } from "@/lib/manage";
import { pressPulse } from "@/lib/motion";
import { PERMIT_TYPES, PERMIT_WINDOW_SECONDS, domainMatches, permitDomain, permitMessage, splitSignature } from "@/lib/permit";
import { assertFresh } from "@/lib/rpc";
import { useGuardian, useKeeperHistory, type GuardianState } from "@/hooks/useGuardian";
import { usePreflight } from "@/hooks/usePreflight";
import { useTx } from "@/hooks/useTx";
import type { PositionInfo } from "@/hooks/usePositions";
import { Tip } from "../Tip";
import { TxStatus } from "../TxStatus";

type Tab = "policy" | "reserve" | "history";

const fmtTime = (t: number | undefined) => (t ? new Date(t * 1000).toLocaleString() : "unknown");
const hoursText = (s: number) => (s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? "" : "s"}` : `${(s / 3600).toFixed(s % 3600 === 0 ? 0 : 1)} hours`);

/** The guardian for one wave 2 position: set a policy, fund the reserve, see what keepers did. */
export function GuardianPanel({ p }: { p: PositionInfo }) {
  const { address } = useAccount();
  const [tab, setTab] = useState<Tab>("policy");
  const q = useGuardian(p.vault, p.tokenId);
  if (!wave2.enabled || !address) return null;
  const g = q.data?.data;
  const stale = !!q.data?.freshness.stale;

  return (
    <section className="block manage" aria-label="Guardian">
      <h4>Guardian</h4>
      <p className="note">
        The guardian adds BTC or repays MUSD from a reserve you fund, only when your ratio falls under a floor you choose, and
        never more than the limits you set. It never refinances. Refinancing stays a button you press yourself, above.
      </p>
      <div className="tabs" role="tablist" aria-label="Guardian sections">
        {(["policy", "reserve", "history"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {t === "policy" ? "Policy" : t === "reserve" ? "Reserve" : "Keeper history"}
          </button>
        ))}
      </div>
      {stale && <p className="banner warn" role="alert">The node is behind the chain, so what is shown here may be old. Nothing can be sent until it catches up.</p>}
      {q.isPending && <div className="skeleton line" aria-label="Reading the guardian" />}
      {q.isError && (
        <p className="banner warn" role="alert">
          Could not read the guardian from this vault. <button className="link" onClick={() => void q.refetch()}>Try again</button>
        </p>
      )}
      {g && tab === "policy" && <PolicyTab p={p} g={g} stale={stale} onChanged={() => void q.refetch()} />}
      {g && tab === "reserve" && <ReserveTab p={p} g={g} stale={stale} onChanged={() => void q.refetch()} />}
      {tab === "history" && <HistoryTab p={p} />}
    </section>
  );
}

function PolicyTab({ p, g, stale, onChanged }: { p: PositionInfo; g: GuardianState; stale: boolean; onChanged: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });
  const qc = useQueryClient();
  const tx = useTx();
  const sug = suggestPolicy(p.coll, p.debt);
  const toText = (v: bigint, d = 18) => (v === 0n ? "" : (Number(v) / 10 ** d).toString());

  const [f, setF] = useState({
    floor: "130", target: "160",
    actBtc: toText(sug.maxActionBtc), actMusd: toText(sug.maxActionMusd),
    capBtc: toText(sug.periodCapBtc), capMusd: toText(sug.periodCapMusd),
    tip: toText(sug.keeperTipBtc), buffer: "", hours: "24", walk: "0",
  });
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const parsed = {
    floorIcr: parsePercent(f.floor), targetIcr: parsePercent(f.target),
    maxActionBtc: parseOptional(f.actBtc), maxActionMusd: parseOptional(f.actMusd),
    periodCapBtc: parseOptional(f.capBtc), periodCapMusd: parseOptional(f.capMusd),
    keeperTipBtc: parseOptional(f.tip), bufferFloorMusd: parseOptional(f.buffer),
  };
  const hours = Number(f.hours);
  const walk = Number(f.walk);
  const complete = Object.values(parsed).every((v) => v !== undefined) && Number.isFinite(hours) && hours > 0 && Number.isInteger(walk) && walk >= 0;
  const input: PolicyInput | undefined = complete
    ? { ...(parsed as Record<keyof typeof parsed, bigint>), period: Math.round(hours * 3600), maxWalkSteps: walk }
    : undefined;
  const problems = input ? validatePolicy(input, g.limits) : ["Fill every field with a number. Leave a limit empty for zero."];
  const warnings = input ? policyWarnings(input) : [];

  const send = async (fn: "setPolicy" | "clearPolicy") => {
    if (!client || !address) return;
    setErr(undefined);
    setBusy(true);
    try {
      await assertFresh();
      const args = fn === "setPolicy" ? [{ epoch: 0n, active: false, ...input! }] : [];
      const params = { address: p.vault, abi: trozuVaultAbi, functionName: fn, args, chainId: config.chainId } as const;
      await client.simulateContract({ ...params, account: address } as never);
      setBusy(false);
      const r = await tx.send(params);
      if (r) {
        void qc.invalidateQueries({ queryKey: ["guardian"] });
        onChanged();
      }
    } catch (e) {
      setErr(friendlyError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const pol = g.policy;
  return (
    <div className="form">
      {pol.active ? (
        <div className="block">
          <h4>{g.live ? "Policy in force" : "Policy switched off"}</h4>
          {!g.live && <p className="note warn">This policy was set by a previous holder, so it does nothing. Set your own below.</p>}
          <dl className="preview">
            <div><dt>Acts under</dt><dd className="mono">{formatIcr(pol.floorIcr)}</dd></div>
            <div><dt>Restores to</dt><dd className="mono">{formatIcr(pol.targetIcr)}</dd></div>
            <div><dt>Max per action</dt><dd className="mono">{formatBtc(pol.maxActionBtc)} BTC · {formatMusd(pol.maxActionMusd)} MUSD</dd></div>
            <div><dt>Per {hoursText(pol.period)}</dt><dd className="mono">{formatBtc(pol.periodCapBtc)} BTC · {formatMusd(pol.periodCapMusd)} MUSD</dd></div>
            <div><dt>Keeper tip</dt><dd className="mono">{formatBtc(pol.keeperTipBtc)} BTC</dd></div>
            <div><dt>Redemption defense</dt><dd className="mono">{pol.bufferFloorMusd === 0n ? "off" : `buffer under ${formatMusd(pol.bufferFloorMusd)} MUSD`}</dd></div>
          </dl>
        </div>
      ) : (
        <p className="note">No policy is set, so the guardian does nothing for this position.</p>
      )}

      {g.plan && (
        <p className={`note ${g.plan.kind !== "None" ? "warn" : ""}`}>
          <b>Right now:</b> {describePlan(g.plan)}
        </p>
      )}

      <h4>{pol.active ? "Replace the policy" : "Set a policy"}</h4>
      <div className="presets">
        <button type="button" className="btn btn-quiet btn-small" onClick={() => setF({ ...f, floor: "130", target: "160", actBtc: toText(sug.maxActionBtc), actMusd: toText(sug.maxActionMusd), capBtc: toText(sug.periodCapBtc), capMusd: toText(sug.periodCapMusd), tip: toText(sug.keeperTipBtc), buffer: "", hours: "24", walk: "0" })}>
          Suggest from my position
        </button>
      </div>
      <div className="two">
        <label className="field"><span>Act when ratio is under (%)<Tip term="icr" label="the collateral ratio" /></span><input inputMode="decimal" value={f.floor} onChange={set("floor")} aria-invalid={!parsed.floorIcr} /></label>
        <label className="field"><span>Restore it to (%)</span><input inputMode="decimal" value={f.target} onChange={set("target")} aria-invalid={!parsed.targetIcr} /></label>
        <label className="field"><span>Most BTC per action</span><input inputMode="decimal" value={f.actBtc} onChange={set("actBtc")} /></label>
        <label className="field"><span>Most MUSD per action</span><input inputMode="decimal" value={f.actMusd} onChange={set("actMusd")} /></label>
        <label className="field"><span>BTC cap per period</span><input inputMode="decimal" value={f.capBtc} onChange={set("capBtc")} /></label>
        <label className="field"><span>MUSD cap per period</span><input inputMode="decimal" value={f.capMusd} onChange={set("capMusd")} /></label>
        <label className="field"><span>Period (hours)</span><input inputMode="decimal" value={f.hours} onChange={set("hours")} /></label>
        <label className="field"><span>Keeper tip (BTC, max {formatBtc(g.limits.maxKeeperTip)})</span><input inputMode="decimal" value={f.tip} onChange={set("tip")} /></label>
        <label className="field"><span>Redemption defense: buffer floor (MUSD, empty = off)<Tip term="buffer" label="the redemption buffer" /></span><input inputMode="decimal" value={f.buffer} onChange={set("buffer")} /></label>
        <label className="field"><span>Queue check length (troves, max {g.limits.maxWalkSteps})</span><input inputMode="numeric" value={f.walk} onChange={set("walk")} /></label>
      </div>
      {problems.map((m) => <p key={m} className="note warn" role="alert">{m}</p>)}
      {warnings.map((m) => <p key={m} className="note warn">{m}</p>)}
      {err && <p className="note warn" role="alert">{err}</p>}
      <TxStatus state={tx.state} successText="The guardian policy is saved." />
      <div className="actions">
        {pol.active && (
          <button className="btn btn-quiet" disabled={busy || tx.busy || stale} onClick={() => void send("clearPolicy")}>Clear policy</button>
        )}
        <button className="btn" disabled={!input || problems.length > 0 || busy || tx.busy || stale} onClick={(e) => { pressPulse(e.currentTarget); void send("setPolicy"); }}>
          {busy ? "Checking…" : pol.active ? "Replace policy" : "Save policy"}
        </button>
      </div>
    </div>
  );
}

type ReserveOp = "fundBtc" | "fundMusd" | "withdrawBtc" | "withdrawMusd";
const OPS: { op: ReserveOp; label: string }[] = [
  { op: "fundBtc", label: "Add BTC" },
  { op: "fundMusd", label: "Add MUSD" },
  { op: "withdrawBtc", label: "Take out BTC" },
  { op: "withdrawMusd", label: "Take out MUSD" },
];

function ReserveTab({ p, g, stale, onChanged }: { p: PositionInfo; g: GuardianState; stale: boolean; onChanged: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });
  const { signTypedDataAsync } = useSignTypedData();
  const qc = useQueryClient();
  const tx = useTx();
  const approveTx = useTx();
  const pre = usePreflight(p.vault, address, undefined, true);
  const data = pre.data?.data;
  const [op, setOp] = useState<ReserveOp>("fundBtc");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const amount = parseOptional(text);
  const amt = amount && amount > 0n ? amount : undefined;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const fresh = windowFresh(g.periodStart, g.policy.period || 1, now);
  const spentBtc = fresh ? 0n : g.spentBtc;
  const spentMusd = fresh ? 0n : g.spentMusd;

  const problems: string[] = [];
  if (!amt) problems.push("Enter an amount.");
  if (amt && data) {
    if (op === "fundBtc" && amt + 2n * 10n ** 15n > data.btc) problems.push("Not enough BTC in your wallet once gas is kept back.");
    if (op === "fundMusd" && amt > data.musd) problems.push(`You hold ${formatMusd(data.musd)} MUSD.`);
  }
  if (amt && op === "withdrawBtc" && amt > g.reserveBtc) problems.push(`The reserve holds ${formatBtc(g.reserveBtc)} BTC.`);
  if (amt && op === "withdrawMusd" && amt > g.reserveMusd) problems.push(`The reserve holds ${formatMusd(g.reserveMusd)} MUSD.`);
  const done = tx.state.status === "success";

  const run = async () => {
    if (!client || !address || !data || !amt) return;
    setErr(undefined);
    setBusy(true);
    try {
      await assertFresh();
      let fn: string;
      let args: unknown[] = [amt];
      let value: bigint | undefined;
      if (op === "fundBtc") { fn = "fundReserveBtc"; args = []; value = amt; }
      else if (op === "withdrawBtc") fn = "withdrawReserveBtc";
      else if (op === "withdrawMusd") fn = "withdrawReserveMusd";
      else {
        fn = "fundReserveMusd";
        const domain = { name: data.permit.name, chainId: config.chainId, verifyingContract: config.mezo.musd };
        const how = approvalFor(amt, data.allowance, domainMatches(domain, data.permit.separator));
        if (how === "permit") {
          const deadline = now + PERMIT_WINDOW_SECONDS;
          const sig = await signTypedDataAsync({
            domain: permitDomain(domain),
            types: PERMIT_TYPES,
            primaryType: "Permit",
            message: permitMessage({ owner: address, spender: p.vault, value: amt, nonce: data.permit.nonce, deadline }),
          });
          const { v, r, s } = splitSignature(sig);
          fn = "fundReserveMusdWithPermit";
          args = [amt, deadline, v, r, s];
        } else if (how === "approve") {
          const r = await approveTx.send({ address: config.mezo.musd, abi: erc20Abi, functionName: "approve", args: [p.vault, amt], chainId: config.chainId });
          if (!r) return;
        }
      }
      const params = { address: p.vault, abi: trozuVaultAbi, functionName: fn, args, value, chainId: config.chainId } as const;
      await client.simulateContract({ ...params, account: address } as never);
      setBusy(false);
      const r = await tx.send(params);
      if (r) {
        void qc.invalidateQueries({ queryKey: ["guardian"] });
        void qc.invalidateQueries({ queryKey: ["preflight"] });
        onChanged();
      }
    } catch (e) {
      setErr(friendlyError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const bar = (spent: bigint, cap: bigint) => (cap === 0n ? 0 : Math.min(100, Number((spent * 10000n) / cap) / 100));
  return (
    <div className="form">
      <dl className="preview">
        <div><dt>Reserve BTC</dt><dd className="mono">{formatBtc(g.reserveBtc)}</dd></div>
        <div><dt>Reserve MUSD</dt><dd className="mono">{formatMusd(g.reserveMusd)}</dd></div>
      </dl>
      <p className="note">The reserve stays in your vault as plain BTC and MUSD. You can take it out at any time, whatever the policy says. It is not used for anything else.</p>
      {g.policy.active && g.live && (
        <div className="block">
          <h4>This period&apos;s allowance{fresh ? " (fresh window)" : ""}</h4>
          <p className="note">BTC used: {formatBtc(spentBtc)} of {formatBtc(g.policy.periodCapBtc)}, {formatBtc(remaining(g.policy.periodCapBtc, spentBtc))} left.</p>
          <div className="meter" aria-hidden><i style={{ width: `${bar(spentBtc, g.policy.periodCapBtc)}%` }} /></div>
          <p className="note">MUSD used: {formatMusd(spentMusd)} of {formatMusd(g.policy.periodCapMusd)}, {formatMusd(remaining(g.policy.periodCapMusd, spentMusd))} left.</p>
          <div className="meter" aria-hidden><i style={{ width: `${bar(spentMusd, g.policy.periodCapMusd)}%` }} /></div>
        </div>
      )}
      <div className="presets" role="group" aria-label="Reserve action">
        {OPS.map((o) => (
          <button key={o.op} type="button" className={`btn btn-small ${op === o.op ? "" : "btn-quiet"}`} onClick={() => { setOp(o.op); setText(""); tx.reset(); approveTx.reset(); setErr(undefined); }}>{o.label}</button>
        ))}
      </div>
      <label className="field">
        <span>{op.endsWith("Btc") ? "Amount (BTC)" : "Amount (MUSD)"}</span>
        <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={text !== "" && !amt} />
      </label>
      {op === "fundMusd" && <p className="note">Adding MUSD uses a signed permit when possible, so there is no separate approval.<Tip term="permit" label="a permit" /></p>}
      {text && problems.map((m) => <p key={m} className="note warn" role="alert">{m}</p>)}
      {pre.isError && <p className="banner warn" role="alert">Could not read your balances. <button className="link" onClick={() => void pre.refetch()}>Try again</button></p>}
      {err && <p className="note warn" role="alert">{err}</p>}
      <TxStatus state={tx.state.status === "idle" && approveTx.state.status !== "idle" ? approveTx.state : tx.state} successText="The reserve is updated." />
      {!done ? (
        <button className="btn" disabled={problems.length > 0 || busy || tx.busy || approveTx.busy || stale || !data} onClick={(e) => { pressPulse(e.currentTarget); void run(); }}>
          {busy ? "Checking…" : OPS.find((o) => o.op === op)!.label}
        </button>
      ) : (
        <button className="btn btn-quiet" onClick={() => { tx.reset(); setText(""); }}>Do another</button>
      )}
    </div>
  );
}

function HistoryTab({ p }: { p: PositionInfo }) {
  const [ask, setAsk] = useState(false);
  const h = useKeeperHistory(p.vault, ask);
  return (
    <div className="form">
      <p className="note">Everyone who called the guardian on this vault, read from its log. A keeper can only do what your policy allows.</p>
      {!ask && <button className="btn btn-quiet" onClick={() => setAsk(true)}>Load history</button>}
      {ask && h.isPending && <div className="skeleton line" aria-label="Reading the vault log" />}
      {h.isError && (
        <p className="banner warn" role="alert">Could not read the log. <button className="link" onClick={() => void h.refetch()}>Try again</button></p>
      )}
      {h.data && h.data.length === 0 && <p className="note">No automatic actions yet. Nobody has called the guardian on this vault.</p>}
      {h.data && h.data.length > 0 && (
        <div className="hist-scroll">
          <table className="hist">
            <thead>
              <tr><th>When</th><th>What</th><th>Amount</th><th>Tip</th><th>Ratio before</th><th>By</th></tr>
            </thead>
            <tbody>
              {h.data.map((r) => (
                <tr key={`${r.tx}-${r.block}`}>
                  <td>{fmtTime(r.time)}</td>
                  <td>{KIND_LABEL[kindName(r.kind)]}</td>
                  <td className="mono">{kindName(r.kind) === "RepayMusd" ? `${formatMusd(r.amount)} MUSD` : `${formatBtc(r.amount)} BTC`}</td>
                  <td className="mono">{formatBtc(r.tip)} BTC</td>
                  <td className="mono">{formatIcr(r.icrBefore)}</td>
                  <td><a className="mono" href={explorerTx(r.tx)} target="_blank" rel="noreferrer">{shortAddress(r.keeper)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
