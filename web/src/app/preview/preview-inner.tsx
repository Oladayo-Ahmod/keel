"use client";

import { OpenPosition } from "@/components/OpenPosition";
import { PositionCard } from "@/components/PositionCard";
import { EmptyState, ErrorState, Skeleton } from "@/components/States";
import type { PositionInfo } from "@/hooks/usePositions";
import Providers from "../providers";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const HOLDER = "0x5104C1A69242D94159Cf7151277252e568cB8F98" as const;

// made-up numbers, only for checking layout
const fixture = (over: Partial<PositionInfo>): PositionInfo => ({
  tokenId: 1n,
  vault: "0x1D5acd83cd4D87F26533A364394e206199af7464",
  holder: HOLDER,
  active: true,
  coll: e18(0.039033),
  principal: e18(2001.8),
  interest: e18(0.05),
  debt: e18(2001.85),
  priceOk: true,
  price: e18(82_000),
  icr: e18(1.5985),
  equity: e18(1198.9),
  lockedRateBps: 100,
  globalRateBps: 60,
  spreadBps: -40n,
  annualSpreadMusd: e18(-8),
  claimableSurplus: 0n,
  refinanceFeeEstimate: e18(0.4),
  redeemable: true,
  recoveryMode: false,
  canClose: true,
  ...over,
});

export default function PreviewInner() {
  return (
    <Providers>
      <main className="shell">
        <p className="banner warn">Layout fixture with made-up numbers. Not real positions.</p>
        <div className="grid" data-testid="grid">
          <PositionCard p={fixture({})} viewer={HOLDER} />
          <PositionCard
            p={fixture({ tokenId: 2n, icr: e18(1.14), equity: e18(-30), coll: e18(0.03), recoveryMode: true, spreadBps: 40n, annualSpreadMusd: e18(8), claimableSurplus: e18(0.002) })}
            viewer={HOLDER}
          />
          <PositionCard p={fixture({ tokenId: 3n, active: false, coll: 0n, debt: 0n, icr: 0n, claimableSurplus: e18(0.01) })} viewer={HOLDER} />
        </div>
        <OpenPosition onOpened={() => undefined} />
        <EmptyState title="No positions in this wallet yet" body="Open one from the factory, or look up an existing position by its NFT id below." />
        <ErrorState message="HTTP request failed. URL: https://rpc.test.mezo.org/ Request body: {...}" onRetry={() => undefined} />
        <Skeleton height={120} />
      </main>
    </Providers>
  );
}
