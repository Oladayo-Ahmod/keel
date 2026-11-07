"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { config } from "@/config";
import { wave2 } from "@/config/wave2";
import { usePositionById } from "@/hooks/usePositions";
import Providers from "@/app/providers";
import { PositionList } from "./PositionList";
import { ShareBar } from "./ShareBar";

function Body({ id, wave }: { id: bigint; wave: "1" | "2" }) {
  const { address } = useAccount();
  const v2 = wave === "2";
  const state = usePositionById(id, v2 ? wave2.lens : config.keel.lens);
  return (
    <div className="grid-stack">
      <ShareBar imagePath={`/og/position/${wave}/${id.toString()}`} />
      <PositionList
        state={state}
        viewer={address}
        nft={v2 ? wave2.nft : undefined}
        v2={v2}
        idle={null}
        empty={<p className="note">No position with this id.</p>}
      />
      {!address && <div><ConnectButton label="Connect wallet to manage" /></div>}
    </div>
  );
}

export default function PositionViewInner({ id, wave }: { id: bigint; wave: "1" | "2" }) {
  return (
    <Providers>
      <Body id={id} wave={wave} />
    </Providers>
  );
}
