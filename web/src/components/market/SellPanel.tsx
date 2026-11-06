"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSignTypedData } from "wagmi";
import { positionNFTAbi } from "@/abi/keel";
import { trozuMarketAbi } from "@/abi/trozu";
import { wave2 } from "@/config/wave2";
import { config } from "@/config";
import { formatMusd } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { LISTING_TYPES, buildListing, explainRevert, feeOn, marketDomain, stateName, stateText } from "@/lib/market";
import { pressPulse } from "@/lib/motion";
import { parseAmount } from "@/lib/open";
import { assertFresh, freshRead } from "@/lib/rpc";
import { useTx } from "@/hooks/useTx";
import type { PositionInfo } from "@/hooks/usePositions";
import { TxStatus } from "../TxStatus";

/** Everything a listing is built from, read together: the epoch, the nonce, the approval and the fee. */
function useSellInputs(tokenId: bigint, owner: `0x${string}` | undefined) {
  return useQuery({
    queryKey: ["sell-inputs", tokenId.toString(), owner],
    enabled: !!owner && wave2.enabled,
    refetchInterval: 20_000,
    retry: 1,
    queryFn: () =>
      freshRead(async (c) => {
        const [epoch, nonce, approved, all, feeBps] = await Promise.all([
          c.readContract({ address: wave2.nft, abi: positionNFTAbi, functionName: "transferEpoch", args: [tokenId] }),
          c.readContract({ address: wave2.market, abi: trozuMarketAbi, functionName: "sellerNonce", args: [owner!] }),
          c.readContract({ address: wave2.nft, abi: positionNFTAbi, functionName: "getApproved", args: [tokenId] }),
          c.readContract({ address: wave2.nft, abi: positionNFTAbi, functionName: "isApprovedForAll", args: [owner!, wave2.market] }),
          c.readContract({ address: wave2.market, abi: trozuMarketAbi, functionName: "FEE_BPS" }),
        ]);
        const isApproved = all || approved.toLowerCase() === wave2.market.toLowerCase();
        return { epoch, nonce, isApproved, feeBps: Number(feeBps) };
      }),
  });
}

const randomSalt = () => BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));

/** List one of your wave 2 positions for sale at a fixed price or as a Dutch auction. */
export function SellPanel({ p }: { p: PositionInfo }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: config.chainId });
  const { signTypedDataAsync } = useSignTypedData();
  const qc = useQueryClient();
  const tx = useTx();
  const approveTx = useTx();
  const inputs = useSellInputs(p.tokenId, address);
  const data = inputs.data?.data;
  const stale = !!inputs.data?.freshness.stale;

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"fixed" | "dutch">("fixed");
  const [startText, setStartText] = useState("");
  const [endText, setEndText] = useState("");
  const [fallHours, setFallHours] = useState("24");
  const [lifeDays, setLifeDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const startPrice = parseAmount(startText);
  const endPrice = parseAmount(endText);
  const fall = BigInt(Math.round((Number(fallHours) || 0) * 3600));
  const life = BigInt(Math.round((Number(lifeDays) || 0) * 86400));

  const built = address && data
    ? buildListing({ seller: address, tokenId: p.tokenId, epoch: data.epoch, nonce: data.nonce, salt: 0n, now: 0n, kind, startPrice, endPrice, fallSeconds: fall, lifeSeconds: life })
    : undefined;
  const errors = built?.errors ?? [];
  const lowest = kind === "dutch" ? endPrice : startPrice;
  const fee = lowest && data ? feeOn(lowest, data.feeBps) : undefined;
  const done = tx.state.status === "success";

  const run = async () => {
    if (!client || !address || !data) return;
    setErr(undefined);
    setBusy(true);
    try {
      await assertFresh();
      if (!data.isApproved) {
        setErr(undefined);
        const r = await approveTx.send({ address: wave2.nft, abi: positionNFTAbi, functionName: "approve", args: [wave2.market, p.tokenId], chainId: config.chainId });
        if (!r) return;
      }
      // the chain's own clock, so a browser running ahead cannot sign a listing that has not started
      const block = await client.getBlock({ blockTag: "latest" });
      const { listing, errors: e2 } = buildListing({
        seller: address, tokenId: p.tokenId, epoch: data.epoch, nonce: data.nonce, salt: randomSalt(),
        now: block.timestamp, kind, startPrice, endPrice, fallSeconds: fall, lifeSeconds: life,
      });
      if (!listing) throw new Error(e2[0]);
      const signature = await signTypedDataAsync({
        domain: marketDomain(config.chainId, wave2.market),
        types: LISTING_TYPES,
        primaryType: "Listing",
        message: listing,
      });
      // ask the market itself whether this would settle, before spending gas publishing it
      const state = stateName((await client.readContract({ address: wave2.market, abi: trozuMarketAbi, functionName: "check", args: [listing, signature] })) as number);
      if (state !== "Ok") throw new Error(stateText(state));
      const params = { address: wave2.market, abi: trozuMarketAbi, functionName: "announce", args: [listing, signature], chainId: config.chainId } as const;
      await client.simulateContract({ ...params, account: address } as never);
      setBusy(false);
      const r = await tx.send(params);
      if (r) {
        void qc.invalidateQueries({ queryKey: ["market"] });
        void qc.invalidateQueries({ queryKey: ["sell-inputs"] });
      }
    } catch (e) {
      setErr(explainRevert(e) ?? friendlyError(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (!wave2.enabled) return null;
  return (
    <section className="block" aria-label="Sell this position">
      <h4>Sell</h4>
      {!open ? (
        <>
          <p className="note">List this position for a fixed price or a falling price. It stays in your wallet until a buyer pays.</p>
          <button className="btn btn-quiet btn-small" onClick={() => setOpen(true)} disabled={!p.active}>List for sale</button>
          {!p.active && <p className="note">There is no open trove, so there is nothing to sell.</p>}
        </>
      ) : (
        <div className="form">
          <div className="presets" role="group" aria-label="Pricing">
            <button type="button" className={`btn btn-small ${kind === "fixed" ? "" : "btn-quiet"}`} onClick={() => setKind("fixed")}>Fixed price</button>
            <button type="button" className={`btn btn-small ${kind === "dutch" ? "" : "btn-quiet"}`} onClick={() => setKind("dutch")}>Dutch auction</button>
          </div>
          <label className="field">
            <span>{kind === "dutch" ? "Starting price (MUSD)" : "Price (MUSD)"}</span>
            <input inputMode="decimal" value={startText} onChange={(e) => setStartText(e.target.value)} aria-invalid={startText !== "" && !startPrice} />
          </label>
          {kind === "dutch" && (
            <div className="two">
              <label className="field">
                <span>Lowest price (MUSD)</span>
                <input inputMode="decimal" value={endText} onChange={(e) => setEndText(e.target.value)} aria-invalid={endText !== "" && !endPrice} />
              </label>
              <label className="field">
                <span>Falls over (hours)</span>
                <input inputMode="decimal" value={fallHours} onChange={(e) => setFallHours(e.target.value)} />
              </label>
            </div>
          )}
          <label className="field">
            <span>Listing stays open (days)</span>
            <input inputMode="decimal" value={lifeDays} onChange={(e) => setLifeDays(e.target.value)} />
          </label>
          {fee !== undefined && lowest && (
            <p className="note">
              At the {kind === "dutch" ? "lowest" : "listed"} price you receive <b className="mono">{formatMusd(lowest - fee)} MUSD</b> after the market&apos;s
              {" "}{(data!.feeBps / 100).toFixed(2)}% fee of {formatMusd(fee)}. The buyer also takes on the debt, so compare the price with your equity.
            </p>
          )}
          <p className="note">
            Whoever holds your signature can buy at the listed price until it expires or you cancel. A buyer sets limits on the
            collateral, debt, rate and reserve, so changing the position after listing only makes the sale fail.
            {data && !data.isApproved && " You will first approve the market to move this one NFT."}
          </p>
          {inputs.isError && <p className="banner warn" role="alert">Could not read the listing inputs. <button className="link" onClick={() => void inputs.refetch()}>Try again</button></p>}
          {stale && <p className="banner warn" role="alert">The node is behind the chain. Wait for it to catch up before listing.</p>}
          {startText && errors.map((m) => <p key={m} className="note warn" role="alert">{m}</p>)}
          {err && <p className="note warn" role="alert">{err}</p>}
          <TxStatus state={tx.state.status === "idle" && approveTx.state.status !== "idle" ? approveTx.state : tx.state} successText="Listed. It now shows in the market." />
          {!done && (
            <div className="actions">
              <button className="btn btn-quiet" disabled={busy || tx.busy} onClick={() => { setOpen(false); tx.reset(); approveTx.reset(); setErr(undefined); }}>Back</button>
              <button className="btn" disabled={!data || stale || errors.length > 0 || busy || tx.busy || approveTx.busy} onClick={(e) => { pressPulse(e.currentTarget); void run(); }}>
                {busy ? "Checking…" : "Sign and list"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
