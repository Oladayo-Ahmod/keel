# Mezo mainnet market data

Read-only snapshot of the MUSD market on Mezo mainnet (chain 31612). Nothing here sends a transaction.

| | |
|---|---|
| Script | [`script/market_data.py`](../script/market_data.py) (Python 3, no dependencies; selectors via `cast keccak`) |
| Raw output | [`docs/market_data.json`](market_data.json) |
| Pinned block | **13,040,764** (2026-11-06 UTC, unix 1793966119). All state reads use this block. |
| RPC | `https://rpc-http.mezo.boar.network` (public) |
| Addresses | from `lib/musd/solidity/artifacts/deployments/mainnet`: TroveManager `0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193`, InterestRateManager `0x4a453700d157717Fe02fB62E7700ED7845048285`, BorrowerOperations `0x44b1bac67dDA612a41a58AAf779143B181dEe031` |

Reproduce: `BLOCK=13040764 python3 script/market_data.py`. The first run scans blocks 0 to the pin in 10,000-block windows (the RPC rejects wider ranges) and takes roughly 25 to 30 minutes; windows are cached in `script/.cache`, so reruns are fast.

## The headline, stated plainly

**The interest rate has never moved, so there is no rate premium to sell.** The global rate is 1.00% (100 bps) now and has been for the protocol's whole life. Every one of the 641 troves ever opened locked 100 bps, and every one of the 215 refinances re-locked 100 bps. `InterestRateManager` has emitted zero `InterestRateProposed` and zero `InterestRateUpdated` events from block 0, and `interestRate()` read by archive `eth_call` at seven spread-out blocks (260,815 through 13,040,764) returns 100 every time. The pitch must not claim that a rate premium, a rate-drop refinance saving or a rate-lock advantage exists in current mainnet data. It does not. Governance can propose a change, which needs a 7-day delay before approval, but none has been proposed.

What the data does support is the redemption story below.

## Current state at block 13,040,764

| | |
|---|---|
| Active troves | **3** |
| Total debt (principal plus interest) | **71,696.20 MUSD** |
| Total collateral | **17.4676 BTC** |
| Global rate | 100 bps, proposed rate 100 bps |

| Trove owner | Locked rate | Collateral (BTC) | Debt (MUSD) |
|---|---|---|---|
| `0x593câ€¦5bb5` | 100 bps | 16.5892 | 14,493.94 |
| `0x467fâ€¦3fb4` | 100 bps | 0.0356 | 2,058.20 |
| `0xa7f5â€¦8738` | 100 bps | 0.8428 | 55,144.06 |

Distribution of per-trove rates against the global rate: three of three sit at exactly the global rate, spread zero.

## Rate history (InterestRateManager events)

| | |
|---|---|
| `InterestRateProposed` events | 0 |
| `InterestRateUpdated` events | 0 |
| Rate at opens (641) | 100 bps: 641 |
| Rate at refinances (215) | 100 bps: 215 |
| `proposedInterestRateTime` | 1747066648 (set at initialisation, never updated) |

## Redemptions (TroveManager `Redemption` events)

| | |
|---|---|
| Redemption transactions | **1,204** |
| MUSD redeemed | **5,896,607.88** (of 6,968,734.58 attempted; see Limits) |
| Trove hits | **1,338**, counted as `TroveUpdated` with operation 2 in the same transaction, so a trove hit twice counts twice. This is not a count of distinct troves. |
| Largest single redemption | 284,083.87 MUSD |
| Median redemption | 984.21 MUSD |
| Most trove hits in one transaction | 10 |
| First / last | 2025-05-27 / 2026-11-06 |
| Last 1,000,000 blocks (since 2026-09-23) | 712 redemptions, 1,291,133 MUSD |
| Last 3,000,000 blocks (since 2026-06-29) | 947 redemptions, 3,020,793 MUSD |

Redemptions are continuous and large relative to today's book. About 5.9M MUSD has been redeemed against a book that now holds 71.7k MUSD of debt. That is the evidence behind a redemption-defense feature, with one caveat: redemption order in this system follows collateral ratio, starting from `sortedTroves.getLast()` (lowest first, per `TroveManager.redeemCollateral`), not the interest rate, so the data supports "positions near the bottom of the sorted list get hit" and says nothing about rate.

## Liquidations (TroveManager `Liquidation` events)

| | |
|---|---|
| Liquidation events | 28 (28 `TroveLiquidated` events) |
| Debt liquidated | 827,968.02 MUSD |
| Collateral seized | 12.3312 BTC |
| First / last | 2025-05-28 / 2026-08-28 |

## Activity

641 troves opened between 2025-05-22 and 2026-11-05, 108 of them in the last 3,000,000 blocks. 215 refinances between 2025-05-23 and 2026-10-03, 13 in the last 3,000,000 blocks.

## Limits

- Public RPC, single provider. It is flaky and caps `eth_getLogs` at 10,000 blocks. The scan retries and caches, but a provider that silently dropped logs would not be detected. The empty rate-event list is cross-checked by the seven archive reads above, which agree.
- The scan starts at block 0 because TroveManager and BorrowerOperations are proxies with several deployments (three each in the artifacts), so the artifact transaction block is not a safe start. Earliest event found: block 418,873. Events emitted by a prior implementation at the same proxy address are included; events from a different proxy address, if the protocol ever migrated, would not be.
- "Troves hit" counts trove-level redemption updates, not distinct addresses.
- Dates come from block timestamps of the first and last events only; I did not compute a per-day series.
- The redemption "attempted" figure is the amount passed in. The gap to "actual" can come from the caller's `_maxIterations` cap or from running out of troves to redeem against. I did not separate the causes.
- This is on-chain system data. It says nothing about who the borrowers are, their intent, or demand for a marketplace or guardian.
