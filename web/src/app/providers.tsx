"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { getConfig, mezoTestnet } from "@mezo-org/passport";
import { useState, type ReactNode } from "react";
import { walletConnectProjectId } from "@/config";

const wagmiConfig = getConfig({
  appName: "KEEL",
  appDescription: "Tradable MUSD positions on Mezo",
  mezoNetwork: "testnet",
  walletConnectProjectId,
});

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
