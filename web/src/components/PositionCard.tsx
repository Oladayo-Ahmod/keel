"use client";

import { useRef, useState } from "react";
import { explorerAddress } from "@/config";
import { formatBtc, formatMusd, shortAddress, toNumber } from "@/lib/format";
import { riskOf } from "@/lib/risk";
import type { PositionInfo } from "@/hooks/usePositions";
import { BufferPanel } from "./BufferPanel";
import { ManagePanel } from "./ManagePanel";
import { Tip } from "./Tip";
import { CountUp } from "./CountUp";
import { RateCompare } from "./RateCompare";
import { RiskGauge } from "./RiskGauge";
import { TransferPanel } from "./TransferPanel";
import { WhatIf } from "./WhatIf";

const NO_DEBT = 2n ** 200n;
const btc = (n: number) => n.toFixed(5);
const musd = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function PositionCard({
  p,
  viewer,
  onChanged,
  stale = false,
  nft,
  v2 = false,
  extra,
}: {
  p: PositionInfo;
  /** NFT contract of this position, when it is not the wave 1 one. */
  nft?: `0x${string}`;
  /** The vault is a wave 2 vault: it holds a guardian reserve that sweep must leave alone. */
  v2?: boolean;
  /** Extra sections, such as the guardian, shown under the management panel. */
  extra?: React.ReactNode;
  viewer?: `0x${string}`;
  onChanged?: () => void;
  /** The node that supplied this data is behind, so nothing here can be called healthy. */
  stale?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [transferring, setTransferring] = useState(false);
  const risk = riskOf(p.icr, p.active, stale);
  const noDebt = p.icr >= NO_DEBT;
  const mine = viewer && viewer.toLowerCase() === p.holder.toLowerCase();

  return (
    <article ref={ref} className={`glass card pos-card risk-${risk.level}`}>
      <header className="card-head">
        <div>
          <h3>Position #{p.tokenId.toString()}<Tip term="trove" label="a trove" /></h3>
          <a className="addr" href={explorerAddress(p.vault)} target="_blank" rel="noreferrer">
            vault {shortAddress(p.vault)}
          </a>
        </div>
        <span className={`chip chip-${risk.level}`}>{risk.label}</span>
      </header>

      {stale && (
        <p className="banner warn" role="alert">
          These numbers come from a node that is behind the chain. They may be out of date, so the ratio is not shown as
          healthy or at risk.
        </p>
      )}
      {p.recoveryMode && !stale && (
        <p className="banner warn" role="alert">
          The system is in Recovery Mode. Closing, refinancing and collateral withdrawals are blocked until it ends.
        </p>
      )}
      {!p.priceOk && (
        <p className="banner warn" role="alert">
          The price feed did not answer, so ratio and equity are unavailable.
        </p>
      )}

      <RiskGauge
        icrRatio={toNumber(p.priceOk ? p.icr : 0n)}
        risk={p.priceOk || stale ? risk : riskOf(0n, false)}
        noDebt={noDebt && p.priceOk && !stale}
      />
      <p className="risk-hint">
        <span className="risk-term">Collateral ratio<Tip term="icr" label="the collateral ratio" /></span>{" "}{stale ? risk.hint : p.priceOk ? risk.hint : "Waiting for the price feed."}</p>

      <dl className={`stats${stale ? " stats-stale" : ""}`}>
        <div>
          <dt>Collateral</dt>
          <dd>
            <CountUp className="mono" value={toNumber(p.coll)} format={btc} /> <small>BTC</small>
          </dd>
        </div>
        <div>
          <dt>Debt</dt>
          <dd>
            <CountUp className="mono" value={toNumber(p.debt)} format={musd} /> <small>MUSD</small>
          </dd>
        </div>
        <div>
          <dt>Equity</dt>
          <dd>
            {p.priceOk ? (
              <>
                <CountUp className="mono" value={toNumber(p.equity)} format={musd} /> <small>USD</small>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>BTC price</dt>
          <dd>{p.priceOk ? <span className="mono">${formatMusd(p.price)}</span> : "—"}</dd>
        </div>
      </dl>

      {p.claimableSurplus > 0n && (
        <p className="banner good">
          <b className="mono">{formatBtc(p.claimableSurplus)} BTC</b> of collateral is waiting to be claimed from a
          redemption or liquidation.
        </p>
      )}

      {p.active && (
        <>
          <RateCompare
            locked={p.lockedRateBps}
            global={p.globalRateBps}
            spreadBps={Number(p.spreadBps)}
            annualSpread={p.annualSpreadMusd}
          />
          <BufferPanel tokenId={p.tokenId} active={p.active} />
          <WhatIf p={p} v2={v2} />
          {!p.canClose && !p.recoveryMode && <p className="note">This trove cannot be closed right now.</p>}
        </>
      )}

      {mine && !transferring && (
        <ManagePanel p={p} stale={stale} v2={v2} onChanged={onChanged} />
      )}

      {mine && !transferring && extra}

      {mine && transferring && (
        <TransferPanel
          p={p}
          nft={nft}
          stale={stale}
          cardRef={ref}
          onClose={() => setTransferring(false)}
          onDone={() => {
            setTransferring(false);
            onChanged?.();
          }}
        />
      )}

      <footer className="card-foot">
        <span>{mine ? "Held by you" : <>Held by <span className="mono">{shortAddress(p.holder)}</span></>}</span>
        {mine && !transferring && (
          <button className="btn btn-quiet btn-small" onClick={() => setTransferring(true)}>
            Transfer
          </button>
        )}
      </footer>
    </article>
  );
}
