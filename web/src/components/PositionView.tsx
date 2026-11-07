"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "./States";

// Wallet libraries touch window, so the view mounts on the client only, like the main app.
const Loaded = dynamic(() => import("./PositionViewInner"), {
  ssr: false,
  loading: () => <Skeleton height={320} />,
});

/** One position by id, readable without a wallet. */
export function PositionView({ id, wave }: { id: bigint; wave: "1" | "2" }) {
  return <Loaded id={id} wave={wave} />;
}
