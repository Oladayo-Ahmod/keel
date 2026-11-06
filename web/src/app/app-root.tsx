"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSwitchChain } from "wagmi";
import { config } from "@/config";
import { usePositionsOf } from "@/hooks/usePositions";
import { EmptyState } from "@/components/States";
import { ChainStatus } from "@/components/ChainStatus";
import { Lookup } from "@/components/Lookup";
import { OpenPosition } from "@/components/OpenPosition";
import { PositionList } from "@/components/PositionList";
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
