"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSignTypedData } from "wagmi";
import { zeroAddress } from "viem";
import { positionVaultAbi } from "@/abi/keel";
import { trozuVaultAbi } from "@/abi/trozu";
import { erc20Abi } from "@/abi/mezo";
import { config } from "@/config";
import { formatBps, formatBtc, formatIcr, formatMusd } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { computeHints } from "@/lib/hints";
import {
  approvalFor,
  closeAllowance,
  maxRepay,
  maxWithdraw,
  planAddCollateral,
  planBorrow,
  planClaim,
  planClose,
  planRefinance,
  planRepay,
  planSweep,
  planWithdraw,
  totalDebt,
  type ClosePlan,
  type Plan,
  type RefinancePlan,
  type Snapshot,
  type Wallet,
} from "@/lib/manage";
import { pressPulse } from "@/lib/motion";
import { parseAmount, GAS_RESERVE } from "@/lib/open";
import { PERMIT_TYPES, PERMIT_WINDOW_SECONDS, domainMatches, permitDomain, permitMessage, splitSignature } from "@/lib/permit";
import { assertFresh } from "@/lib/rpc";
import { SAFE } from "@/lib/risk";
import { needsHints, vaultCall, type ActionKind, type Hints, type PermitSig } from "@/lib/vaultCall";
import { usePreflight, type Preflight } from "@/hooks/usePreflight";
import { useTx } from "@/hooks/useTx";
import type { PositionInfo } from "@/hooks/usePositions";
import { Tip } from "./Tip";
import { TxStatus } from "./TxStatus";

const TABS: { kind: ActionKind; label: string }[] = [
  { kind: "add", label: "Add collateral" },
  { kind: "withdraw", label: "Withdraw" },
  { kind: "borrow", label: "Borrow" },
  { kind: "repay", label: "Repay" },
  { kind: "refinance", label: "Refinance" },
  { kind: "close", label: "Close" },
  { kind: "claim", label: "Claim surplus" },
  { kind: "sweep", label: "Sweep" },
];

const AMOUNT_LABEL: Partial<Record<ActionKind, string>> = {
  add: "Collateral to add (BTC)",
  withdraw: "Collateral to withdraw (BTC)",
  borrow: "MUSD to borrow",
  repay: "MUSD to repay",
};

const snapshotOf = (p: PositionInfo): Snapshot => ({
  active: p.active,
  priceOk: p.priceOk,
  price: p.price,
  coll: p.coll,
  principal: p.principal,
  interest: p.interest,
  recoveryMode: p.recoveryMode,
  canClose: p.canClose,
  lockedRateBps: p.lockedRateBps,
  globalRateBps: p.globalRateBps,
  refinanceFeeEstimate: p.refinanceFeeEstimate,
  annualSpreadMusd: p.annualSpreadMusd,
  claimableSurplus: p.claimableSurplus,
});

const text = (wei: bigint) => (Number(wei) / 1e18).toFixed(6);

/** Everything a holder can do to a position, one action at a time, each checked before the wallet opens. */
export function ManagePanel({ p, stale = false, v2 = false, onChanged }: { p: PositionInfo; stale?: boolean; v2?: boolean; onChanged?: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });
  const { signTypedDataAsync } = useSignTypedData();
  const qc = useQueryClient();
  const tx = useTx();
  const approveTx = useTx();

  const [kind, setKind] = useState<ActionKind>(p.active ? "add" : "claim");
  const [amountText, setAmountText] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prepError, setPrepError] = useState<string | undefined>();
  const [sweepToken, setSweepToken] = useState<`0x${string}`>(zeroAddress);
  const [customToken, setCustomToken] = useState("");
  const [note, setNote] = useState<string | undefined>();

  const amount = parseAmount(amountText);
  const usesAmount = kind in AMOUNT_LABEL;
  const pre = usePreflight(p.vault, address, kind === "borrow" ? amount : undefined, v2);
  const data = pre.data?.data;
  const nodeStale = stale || !!pre.data?.freshness.stale;

  const snap = useMemo(() => snapshotOf(p), [p]);
  const plan: Plan | RefinancePlan | ClosePlan | undefined = useMemo(() => {
    if (nodeStale) return undefined;
    const w: Wallet = { btc: data?.btc, musd: data?.musd, allowance: data?.allowance, minNetDebt: data?.minNetDebt };
    switch (kind) {
      case "add": return amount ? planAddCollateral(snap, amount, w) : undefined;
      case "withdraw": return amount ? planWithdraw(snap, amount) : undefined;
      case "borrow": return amount ? planBorrow(snap, amount, data?.fee) : undefined;
      case "repay": return amount ? planRepay(snap, amount, w) : undefined;
      case "refinance": return planRefinance(snap);
      case "close": return planClose(snap, w);
      case "claim": return planClaim(snap);
      case "sweep": return undefined;
    }
  }, [kind, amount, snap, data, nodeStale]);

  const sweepInfo = data ? planSweep(data.vaultBtc, data.vaultMusd) : undefined;
  const loading = pre.isPending && !!address;
  const blocking = !plan || plan.errors.length > 0 || !data;
  const done = tx.state.status === "success";

  const pick = (k: ActionKind) => {
    setKind(k);
    setAmountText("");
    setReview(false);
    setPrepError(undefined);
    setNote(undefined);
    tx.reset();
    approveTx.reset();
  };

  const setMax = () => {
    if (!data) return;
    if (kind === "add") setAmountText(text(data.btc > GAS_RESERVE ? data.btc - GAS_RESERVE : 0n));
    if (kind === "withdraw") setAmountText(text(maxWithdraw(snap, SAFE)));
    if (kind === "repay") {
      const cap = maxRepay(snap, data.minNetDebt);
      setAmountText(text(cap < data.musd ? cap : data.musd));
    }
  };

  const run = async () => {
    if (!client || !address || !data) return;
    setPrepError(undefined);
    setNote(undefined);
    setBusy(true);
    try {
      // one more look at the chain head before anything is simulated or signed
      await assertFresh();

      let hints: Hints | undefined;
      if (needsHints(kind)) {
        if (plan?.hintNicr !== undefined) {
          const [upper, lower] = await computeHints(client, plan.hintNicr);
          hints = { upper, lower };
        } else {
          hints = { upper: zeroAddress, lower: zeroAddress };
        }
      }

      let permit: PermitSig | undefined;
      const pulled = kind === "repay" ? amount : kind === "close" ? (plan as ClosePlan).cost : undefined;
      if (pulled !== undefined && pulled > 0n) {
        const domain = { name: data.permit.name, chainId: config.chainId, verifyingContract: config.mezo.musd };
        const permitOk = kind === "repay" && domainMatches(domain, data.permit.separator);
        // a close cannot use a permit: interest moves the exact cost every second, which would void the signature
        const need = kind === "close" ? closeAllowance(pulled) : pulled;
        const how = kind === "close" ? (data.allowance >= pulled ? "allowance" : "approve") : approvalFor(pulled, data.allowance, permitOk);
        if (how === "permit") {
          const deadline = BigInt(Math.floor(Date.now() / 1000)) + PERMIT_WINDOW_SECONDS;
          const signature = await signTypedDataAsync({
            domain: permitDomain(domain),
            types: PERMIT_TYPES,
            primaryType: "Permit",
            message: permitMessage({ owner: address, spender: p.vault, value: pulled, nonce: data.permit.nonce, deadline }),
          });
          permit = { deadline, ...splitSignature(signature) };
        } else if (how === "approve") {
          setNote("Approve the vault to take this MUSD first. Then you confirm the action itself.");
          const r = await approveTx.send({
            address: config.mezo.musd,
            abi: erc20Abi,
            functionName: "approve",
            args: [p.vault, need],
            chainId: config.chainId,
          });
          if (!r) {
            setBusy(false);
            return;
          }
        }
      }

      const maxFee = kind === "borrow" ? (data.fee ?? 0n) + (data.fee ?? 0n) / 20n + 1n : kind === "refinance" ? (plan as RefinancePlan).maxFee : undefined;
      const built = vaultCall({
        kind,
        amount: usesAmount ? amount : undefined,
        hints,
        maxFee,
        permit,
        token: kind === "sweep" ? sweepToken : undefined,
      });
      // the wave 2 ABI also knows the errors only a wave 2 vault can raise, such as the debt cap
      const params = { address: p.vault, abi: v2 ? trozuVaultAbi : positionVaultAbi, ...built, chainId: config.chainId } as const;
      // simulate against the real chain so a revert shows as a sentence, not a failed transaction
      await client.simulateContract({ ...params, account: address } as never);
      setBusy(false);
      const receipt = await tx.send(params);
      if (receipt) {
        void qc.invalidateQueries({ queryKey: ["preflight"] });
        onChanged?.();
      }
    } catch (e) {
      setPrepError(friendlyError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const customOk = /^0x[0-9a-fA-F]{40}$/.test(customToken.trim());

  return (
    <section className="block manage" aria-label="Manage this position">
      <h4>Manage</h4>
      <div className="tabs" role="tablist" aria-label="Position actions">
        {TABS.filter((t) => p.active || t.kind === "claim" || t.kind === "sweep").map((t) => (
          <button
            key={t.kind}
            role="tab"
            aria-selected={kind === t.kind}
            className={`tab${kind === t.kind ? " on" : ""}`}
            onClick={() => pick(t.kind)}
            disabled={busy || tx.busy}
          >
            {t.label}
          </button>
        ))}
      </div>

      {nodeStale && (
        <p className="banner warn" role="alert">
          The node that answered is behind the chain, so balances and the ratio cannot be trusted. Nothing can be sent until a
          current node answers.{" "}
          <button className="link" onClick={() => void pre.refetch()}>Check again</button>
        </p>
      )}
      {pre.isError && (
        <p className="banner warn" role="alert">
          Could not read your balances or Mezo&apos;s limits.{" "}
          <button className="link" onClick={() => void pre.refetch()}>Try again</button>
        </p>
      )}
      {loading && !pre.isError && <div className="skeleton line" aria-label="Checking your balances" />}

      {!review && !done && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocking) setReview(true);
          }}
        >
          {usesAmount && (
            <label className="field">
              <span>{AMOUNT_LABEL[kind]}</span>
              <input inputMode="decimal" placeholder="0.0" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-invalid={amountText !== "" && !amount} />
            </label>
          )}
          {usesAmount && (kind === "add" || kind === "withdraw" || kind === "repay") && (
            <div className="presets">
              <button type="button" className="btn btn-quiet btn-small" disabled={!data || nodeStale} onClick={setMax}>
                {kind === "withdraw" ? "Most that keeps 150%" : "Max"}
              </button>
            </div>
          )}

          {kind === "refinance" && plan && <RefinanceFacts plan={plan as RefinancePlan} snap={snap} />}
          {kind === "close" && plan && <CloseFacts plan={plan as ClosePlan} />}
          {kind === "claim" && (
            <p className="note">
              {p.claimableSurplus > 0n ? (
                <>
                  <b className="mono">{formatBtc(p.claimableSurplus)} BTC</b> is waiting from a redemption or liquidation.
                  <Tip term="surplus" label="surplus collateral" />
                </>
              ) : (
                <>Nothing to claim. Collateral appears here after a redemption or liquidation leaves some behind.</>
              )}
            </p>
          )}
          {kind === "sweep" && data && (
            <SweepChoice
              btc={data.vaultBtc}
              musd={data.vaultMusd}
              token={sweepToken}
              onToken={setSweepToken}
              custom={customToken}
              onCustom={setCustomToken}
              customOk={customOk}
            />
          )}

          {usesAmount && plan && amount && <Outcome plan={plan} snap={snap} />}
          {plan?.errors.map((m) => <p key={m} className="note warn" role="alert">{m}</p>)}
          {plan?.warnings.map((m) => <p key={m} className="note warn">{m}</p>)}
          {kind === "sweep" && sweepInfo && !sweepInfo.sweepable && <p className="note">{sweepInfo.errors[0]}</p>}

          <button
            className="btn"
            type="submit"
            disabled={kind === "sweep" ? !sweepInfo?.sweepable || nodeStale || (sweepToken !== zeroAddress && sweepToken !== config.mezo.musd && !customOk) : blocking}
            onClick={(e) => {
              pressPulse(e.currentTarget);
              if (kind === "sweep") {
                e.preventDefault();
                setReview(true);
              }
            }}
          >
            Review
          </button>
        </form>
      )}

      {review && !done && (
        <div className="review">
          <h3>Check before you send</h3>
          <ReviewFacts kind={kind} amount={amount} plan={plan} data={data} token={sweepToken} />
          <p className="note">
            Sorted-list hints are looked up when you press the button, the call is simulated on the chain first, and your wallet
            only opens if the simulation passes.
          </p>
          {note && <p className="note">{note}</p>}
          {kind === "repay" && data && amount && (
            <ApprovalNote amount={amount} allowance={data.allowance} permitOk={domainMatches({ name: data.permit.name, chainId: config.chainId, verifyingContract: config.mezo.musd }, data.permit.separator)} />
          )}
          {kind === "close" && <p className="note">Closing asks for a MUSD approval a little above the cost, because interest keeps accruing until the transaction is mined. The vault only takes the exact cost.</p>}
          {prepError && <p className="note warn" role="alert">{prepError}</p>}
          <TxStatus state={tx.state.status === "idle" && approveTx.state.status !== "idle" ? approveTx.state : tx.state} successText={SUCCESS[kind]} />
          <div className="actions">
            <button className="btn btn-quiet" disabled={busy || tx.busy || approveTx.busy} onClick={() => { setReview(false); tx.reset(); approveTx.reset(); setPrepError(undefined); setNote(undefined); }}>
              Back
            </button>
            <button
              className="btn"
              disabled={busy || tx.busy || approveTx.busy || nodeStale}
              onClick={(e) => {
                pressPulse(e.currentTarget);
                void run();
              }}
            >
              {busy ? "Checking…" : tx.state.status === "failed" ? "Try again" : CONFIRM[kind]}
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="review">
          <TxStatus state={tx.state} successText={SUCCESS[kind]} />
          <button className="btn btn-quiet" onClick={() => pick(kind)}>Do another</button>
        </div>
      )}
    </section>
  );
}

const SUCCESS: Record<ActionKind, string> = {
  add: "The collateral is in your trove.",
  withdraw: "The collateral is in your wallet.",
  borrow: "The MUSD is in your wallet.",
  repay: "The debt is lower.",
  refinance: "The trove now carries the market rate.",
  close: "The trove is closed and the collateral is back in your wallet.",
  claim: "The surplus is in your wallet.",
  sweep: "The funds are in your wallet.",
};

const CONFIRM: Record<ActionKind, string> = {
  add: "Add collateral",
  withdraw: "Withdraw",
  borrow: "Borrow",
  repay: "Repay",
  refinance: "Refinance",
  close: "Close position",
  claim: "Claim",
  sweep: "Sweep",
};

function Outcome({ plan, snap }: { plan: Plan; snap: Snapshot }) {
  const before = totalDebt(snap);
  return (
    <dl className="preview">
      <div><dt>Collateral<Tip term="trove" label="a trove" /></dt><dd className="mono">{formatBtc(plan.newColl)} BTC</dd></div>
      <div><dt>Debt</dt><dd className="mono">{formatMusd(plan.newDebt)} MUSD</dd></div>
      <div><dt>Ratio<Tip term="icr" label="the collateral ratio" /></dt><dd className="mono">{plan.newIcr === undefined ? "no debt" : formatIcr(plan.newIcr)}</dd></div>
      <div><dt>Before</dt><dd className="mono">{formatIcr(before === 0n ? 2n ** 200n : (snap.coll * snap.price) / before)}</dd></div>
    </dl>
  );
}

function RefinanceFacts({ plan, snap }: { plan: RefinancePlan; snap: Snapshot }) {
  return (
    <>
      <dl className="preview">
        <div><dt>Locked rate<Tip term="lockedRate" label="the locked rate" /></dt><dd className="mono">{formatBps(snap.lockedRateBps)}</dd></div>
        <div><dt>Market rate</dt><dd className="mono">{formatBps(snap.globalRateBps)}</dd></div>
        <div><dt>Rate drop</dt><dd className="mono">{plan.dropBps > 0 ? `-${formatBps(plan.dropBps)}` : formatBps(0)}</dd></div>
        <div><dt>Fee<Tip term="refinance" label="refinancing" /></dt><dd className="mono">{formatMusd(plan.fee)} MUSD</dd></div>
      </dl>
      {plan.errors.length === 0 && (
        <p className="note good">
          Saves about <b className="mono">{formatMusd(plan.yearlySaving)} MUSD</b> a year at today&apos;s principal.
          {plan.breakEvenDays !== undefined && <> The fee is paid back in about {Math.ceil(plan.breakEvenDays)} days.</>} The fee is added to your debt, and the
          transaction reverts if it comes out above {formatMusd(plan.maxFee)} MUSD.
        </p>
      )}
    </>
  );
}

function CloseFacts({ plan }: { plan: ClosePlan }) {
  return (
    <dl className="preview">
      <div><dt>You pay<Tip term="reserve" label="the 200 MUSD reserve" /></dt><dd className="mono">{formatMusd(plan.cost)} MUSD</dd></div>
      <div><dt>You get back</dt><dd className="mono">{formatBtc(plan.returned)} BTC</dd></div>
    </dl>
  );
}

function SweepChoice(props: {
  btc: bigint;
  musd: bigint;
  token: `0x${string}`;
  onToken: (t: `0x${string}`) => void;
  custom: string;
  onCustom: (v: string) => void;
  customOk: boolean;
}) {
  const custom = props.token !== zeroAddress && props.token !== config.mezo.musd;
  return (
    <>
      <p className="note">
        Sweep returns anything that landed in the vault outside a normal flow, such as a forced BTC send or a token sent by
        mistake. It never touches the trove.
      </p>
      <div className="presets" role="group" aria-label="What to sweep">
        <button type="button" className={`btn btn-small ${props.token === zeroAddress ? "" : "btn-quiet"}`} disabled={props.btc === 0n} onClick={() => props.onToken(zeroAddress)}>
          BTC · {formatBtc(props.btc)}
        </button>
        <button type="button" className={`btn btn-small ${props.token === config.mezo.musd ? "" : "btn-quiet"}`} disabled={props.musd === 0n} onClick={() => props.onToken(config.mezo.musd)}>
          MUSD · {formatMusd(props.musd)}
        </button>
        <button type="button" className={`btn btn-small ${custom ? "" : "btn-quiet"}`} onClick={() => props.onToken(props.customOk ? (props.custom.trim() as `0x${string}`) : ("0x" as `0x${string}`))}>
          Another token
        </button>
      </div>
      {custom && (
        <label className="field">
          <span>Token contract address</span>
          <input
            className="mono"
            value={props.custom}
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={props.custom !== "" && !props.customOk}
            onChange={(e) => {
              props.onCustom(e.target.value);
              if (/^0x[0-9a-fA-F]{40}$/.test(e.target.value.trim())) props.onToken(e.target.value.trim() as `0x${string}`);
            }}
          />
        </label>
      )}
    </>
  );
}

function ApprovalNote({ amount, allowance, permitOk }: { amount: bigint; allowance: bigint; permitOk: boolean }) {
  const how = approvalFor(amount, allowance, permitOk);
  return (
    <p className="note">
      {how === "allowance" && "The vault already has enough MUSD allowance, so no signature or approval is needed."}
      {how === "permit" && (
        <>
          You will sign a permit for exactly this amount. It costs no gas and is good for ten minutes.
          <Tip term="permit" label="a permit" />
        </>
      )}
      {how === "approve" && "This token's signing details could not be confirmed, so you will approve the vault in a separate transaction first."}
    </p>
  );
}

function ReviewFacts({ kind, amount, plan, data, token }: { kind: ActionKind; amount: bigint | undefined; plan: Plan | undefined; data: Preflight | undefined; token: `0x${string}` }) {
  const rows: [string, string][] = [];
  if (kind === "add" && amount) rows.push(["You add", `${formatBtc(amount)} BTC`]);
  if (kind === "withdraw" && amount) rows.push(["You take out", `${formatBtc(amount)} BTC`]);
  if (kind === "borrow" && amount) {
    rows.push(["You receive", `${formatMusd(amount)} MUSD`]);
    if (data?.fee !== undefined) rows.push(["Borrowing fee", `${formatMusd(data.fee)} MUSD`]);
  }
  if (kind === "repay" && amount) rows.push(["You repay", `${formatMusd(amount)} MUSD`]);
  if (kind === "close" && plan) rows.push(["You pay", `${formatMusd((plan as ClosePlan).cost)} MUSD`], ["You get back", `${formatBtc((plan as ClosePlan).returned)} BTC`]);
  if (kind === "refinance" && plan) {
    const r = plan as RefinancePlan;
    rows.push(["Rate drop", `-${formatBps(r.dropBps)}`], ["Fee at most", `${formatMusd(r.maxFee)} MUSD`]);
  }
  if (kind === "claim") rows.push(["You claim", "all surplus collateral"]);
  if (kind === "sweep") rows.push(["You sweep", token === zeroAddress ? "BTC" : token === config.mezo.musd ? "MUSD" : token]);
  if (plan && (kind === "add" || kind === "withdraw" || kind === "borrow" || kind === "repay")) {
    rows.push(["New ratio", plan.newIcr === undefined ? "no debt" : formatIcr(plan.newIcr)]);
  }
  return (
    <dl className="preview">
      {rows.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>
      ))}
    </dl>
  );
}
