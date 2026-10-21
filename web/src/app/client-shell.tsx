"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/States";

// Wallet libraries touch window, so the whole app mounts on the client only.
const App = dynamic(() => import("./app-root"), {
  ssr: false,
  loading: () => (
    <main className="shell">
      <Skeleton height={64} />
      <Skeleton height={220} />
    </main>
  ),
});

export default function ClientShell() {
  return <App />;
}
