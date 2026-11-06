"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSwitchChain } from "wagmi";
import { useState } from "react";
import { config } from "@/config";
import { wave2 } from "@/config/wave2";
import { usePositionsOf } from "@/hooks/usePositions";
import { EmptyState } from "@/components/States";
import { ChainStatus } from "@/components/ChainStatus";
import { Lookup } from "@/components/Lookup";
import { OpenPosition } from "@/components/OpenPosition";
import { PositionList } from "@/components/PositionList";
import { GuardianPanel } from "@/components/guardian/GuardianPanel";
import { MarketScreen } from "@/components/market/MarketScreen";
import { SellPanel } from "@/components/market/SellPanel";
import Providers from "./providers";

function Header() {
  return (
    <header className="top">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 19c3 6 8 9 13 9s10-3 13-9H3Z" strokeLinejoin="round" />
          <path d="M16 4v15M16 4c3 4 6 9 9 15M16 4c-3 4-6 9-9 15" strokeLinejoin="round" />
        </svg>
        <span>Trozu</span>
        <span className="net">{config.name}</span>
        <ChainStatus />
      </div>
      <ConnectButton chainStatus="icon" showBalance={false} accountStatus="address" />
    </header>
  );
}

function WrongNetwork() {
  const { switchChain, isPending } = useSwitchChain();
  return (
    <div className="banner warn" role="alert">
      <span>Your wallet is on another network. Trozu positions live on {config.name}.</span>
      <button className="btn btn-small" disabled={isPending} onClick={() => switchChain({ chainId: config.chainId })}>
        {isPending ? "Switching…" : `Switch to ${config.name}`}
      </button>
    </div>
  );
}

function Dashboard() {
  const { address, isConnected, chainId } = useAccount();
  const state = usePositionsOf(isConnected ? address : undefined);
  // wave 2 is hidden until the flag is on, so nothing below changes for anyone before then
  const state2 = usePositionsOf(wave2.enabled && isConnected ? address : undefined, wave2.lens);
  const [view, setView] = useState<"positions" | "market">("positions");

  return (
    <main className="shell">
      <Header />
      <section className="hero">
        <h1>Your MUSD positions</h1>
        <p>
          Each position is a trove inside its own vault, held as an NFT. Move the NFT and the whole position, collateral,
          debt and locked rate, moves with it.
        </p>
      </section>

      {isConnected && chainId !== config.chainId && <WrongNetwork />}

      {wave2.enabled && (
        <div className="subnav" role="tablist" aria-label="Sections">
          <button role="tab" aria-selected={view === "positions"} className={`tab${view === "positions" ? " on" : ""}`} onClick={() => setView("positions")}>Positions</button>
          <button role="tab" aria-selected={view === "market"} className={`tab${view === "market" ? " on" : ""}`} onClick={() => setView("market")}>Market</button>
        </div>
      )}

      {wave2.enabled && view === "market" && <MarketScreen />}

      {(!wave2.enabled || view === "positions") && (
      <>
      {wave2.enabled && (
        <section className="grid-stack" aria-label="Trozu positions">
          <h2>Market and guardian positions</h2>
          <PositionList
            state={state2}
            viewer={address}
            nft={wave2.nft}
            v2
            extra={(p) => (
              <>
                <SellPanel p={p} />
                <GuardianPanel p={p} />
              </>
            )}
            idle={<EmptyState title="Connect a wallet to see these positions" body="Positions opened through the Trozu factory can be sold on the market and protected by a guardian." action={<ConnectButton label="Connect wallet" />} />}
            empty={<EmptyState title="No Trozu positions in this wallet" body="Open one below. It works like a wave 1 position and can also be sold and guarded." />}
          />
          <OpenPosition factory={wave2.factory} title="Open a market-ready position" onOpened={() => state2.status === "ready" && state2.refresh()} />
          <h2>Wave 1 positions</h2>
        </section>
      )}

      <PositionList
        state={state}
        viewer={address}
        idle={
          <EmptyState
            title="Connect a wallet to see your positions"
            body="Positions are read from the chain. Connecting only lets the app know which address to look up."
            action={<ConnectButton label="Connect wallet" />}
          />
        }
        empty={
          <EmptyState
            title="No positions in this wallet yet"
            body="Open one from the factory, or look up an existing position by its NFT id below."
          />
        }
      />

      <OpenPosition onOpened={() => state.status === "ready" && state.refresh()} />

      <Lookup />
      </>
      )}

      <footer className="foot">
        <span>Testnet only. Not audited.</span>
      </footer>
    </main>
  );
}

export default function AppRoot() {
  return (
    <Providers>
      <Dashboard />
    </Providers>
  );
}
