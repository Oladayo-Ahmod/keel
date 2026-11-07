"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { getConfig, mezoTestnet } from "@mezo-org/passport";
import { useState, type ReactNode } from "react";
import { walletConnectProjectId } from "@/config";
import { makeTransport } from "@/lib/rpc";

// the e2e config is a test-only build flag; in a normal build this branch and its module are removed
const wagmiConfig = process.env.NEXT_PUBLIC_E2E === "1"
  ? (require("@/e2e/config") as typeof import("@/e2e/config")).e2eWagmiConfig
  : getConfig({
  appName: "Trozu",
  appDescription: "Tradable MUSD positions on Mezo",
  mezoNetwork: "testnet",
  walletConnectProjectId,
  // retries and fallback endpoints for everything wagmi does (receipts, balances, wallet reads);
  // Passport spreads these after its own http transport. Its type does not expose the field.
  transports: { [mezoTestnet.id]: makeTransport() },
} as Parameters<typeof getConfig>[0]);

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 2, staleTime: 8_000 } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={mezoTestnet}
          theme={lightTheme({ accentColor: "#1d2b3a", accentColorForeground: "#ffffff", borderRadius: "medium", fontStack: "system" })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
