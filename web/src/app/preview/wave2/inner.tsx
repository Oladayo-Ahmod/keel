"use client";

import { PolicyTab, ReserveTab } from "@/components/guardian/GuardianPanel";
import { DutchChart } from "@/components/market/DutchChart";
import { ListingCard } from "@/components/market/MarketScreen";
import type { MarketRow } from "@/hooks/useMarket";
import type { GuardianState } from "@/hooks/useGuardian";
import type { PositionInfo } from "@/hooks/usePositions";
import { LIMITS } from "@/lib/guardian";
import type { Listing } from "@/lib/market";
import { WhatIfBody, setupOf } from "@/components/WhatIf";
import { FairPriceHint } from "@/components/market/FairPriceHint";
import Providers from "../../providers";

const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const SELLER = "0x5104C1A69242D94159Cf7151277252e568cB8F98" as const;
const now = BigInt(Math.floor(Date.now() / 1000));

// made-up numbers, only for checking layout
const info: PositionInfo = {
  tokenId: 4n, vault: "0x1D5acd83cd4D87F26533A364394e206199af7464", holder: SELLER, active: true,
  coll: e18(0.05), principal: e18(1_990), interest: e18(2), debt: e18(1_992), priceOk: true, price: e18(82_000),
  icr: e18(2.05), equity: e18(2_108), lockedRateBps: 100, globalRateBps: 100, spreadBps: 0n, annualSpreadMusd: 0n,
  claimableSurplus: 0n, refinanceFeeEstimate: e18(0.4), redeemable: true, recoveryMode: false, canClose: true,
};

const dutch: Listing = {
  seller: SELLER, tokenId: 4n, epoch: 1n, startPrice: e18(2_400), endPrice: e18(1_900),
  startTime: now - 6n * 3600n, endTime: now + 18n * 3600n, deadline: now + 5n * 86400n, nonce: 0n, salt: 1n,
};
const fixed: Listing = { ...dutch, tokenId: 5n, startPrice: e18(2_050), endPrice: e18(2_050), endTime: dutch.startTime };

const row = (listing: Listing): MarketRow => ({
  hash: `0x${listing.tokenId.toString(16).padStart(64, "0")}`, listing, signature: "0x", state: "Ok",
  info: { ...info, tokenId: listing.tokenId }, reserveBtc: e18(0.01), reserveMusd: 0n,
});

const guardian: GuardianState = {
  policy: {
    epoch: 1n, floorIcr: e18(1.3), targetIcr: e18(1.6), maxActionBtc: e18(0.01), maxActionMusd: e18(400),
    periodCapBtc: e18(0.02), periodCapMusd: e18(800), keeperTipBtc: e18(0.00005), bufferFloorMusd: 0n,
    period: 86400, maxWalkSteps: 0, active: true,
  },
  live: true,
  plan: { kind: "None", reason: "Healthy", amount: 0n, tip: 0n, icr: e18(2.05) },
  reserveBtc: e18(0.01), reserveMusd: e18(100), spentBtc: e18(0.004), spentMusd: 0n,
  periodStart: now - 3600n, epoch: 1n, limits: LIMITS,
};

export default function Inner() {
  return (
    <Providers>
      <main className="shell">
        <p className="banner warn">Layout fixture with made-up numbers. Not real listings or positions.</p>
        <div className="listing-grid" data-testid="listings">
          <ListingCard row={row(dutch)} feeBps={25} now={now} stale={false} onBought={() => undefined} />
          <ListingCard row={row(fixed)} feeBps={25} now={now} stale={false} onBought={() => undefined} />
        </div>
        <section className="glass card"><DutchChart listing={dutch} nowSeconds={now} /></section>
        <section className="glass card guardian-fixture"><PolicyTab p={info} g={guardian} stale={false} onChanged={() => undefined} /></section>
        <section className="glass card guardian-fixture"><ReserveTab p={info} g={guardian} stale={false} onChanged={() => undefined} /></section>
        <section className="glass card" data-testid="whatif-fixture">
          <WhatIfBody p={{ ...info, icr: e18(2.05) }} guardian={setupOf(guardian)} chainPlan={guardian.plan}
            fixture={{ minNetDebt: e18(1_800), buffer: { inList: true, value: e18(6_000), complete: true, steps: 12 } }} />
        </section>
        <section className="glass card" data-testid="hint-fixture">
          <FairPriceHint p={{ ...info, lockedRateBps: 100, globalRateBps: 300, spreadBps: 200n }} kind="dutch" stale={false} onUse={() => undefined} />
        </section>
      </main>
    </Providers>
  );
}
