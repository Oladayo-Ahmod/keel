# Architecture

KEEL wraps a Mezo MUSD trove in a minimal-proxy vault and represents the vault as an ERC-721. Whoever holds the NFT controls the trove. Moving the NFT moves the whole position: collateral, debt and the locked interest rate.

Facts about MUSD that this design depends on are cited in [VERIFICATION.md](VERIFICATION.md).

## Scope

| Wave | Contracts |
|---|---|
| 1 (due Oct 26) | `PositionFactory`, `PositionVault`, `PositionNFT`, `PositionLens`, testnet deploy, UI |
| 2 | State-committed marketplace (fixed price, Dutch auction), policy-bounded guardian, keeper script |

The wave 2 marketplace attaches to wave 1 contracts unchanged. The guardian needs a vault v2, see [Extension points](#extension-points).

## Components

```
                    holder (EOA or contract)
                      |   ownerOf(tokenId)
                      v
 PositionFactory --mints--> PositionNFT (ERC-721, enumerable, transferEpoch)
      |                          ^
      | clone + initialize       | ownerOf(tokenId) on every call
      v                          |
 PositionVault (EIP-1167 clone, one per position)
      |  msg.sender = vault = trove borrower
      v
 Mezo MUSD core: BorrowerOperations, TroveManager, SortedTroves, ActivePool, CollSurplusPool, MUSD

 PositionLens (stateless views) ---> reads vault, TroveManager, SortedTroves, PriceFeed, InterestRateManager
```

### PositionNFT

- OpenZeppelin `ERC721Enumerable`. Enumeration lets the UI list a wallet's positions without an indexer.
- `mint` is callable only by the factory (immutable address, set in the factory constructor).
- `tokenId -> vault` mapping, written at mint.
- `transferEpoch[tokenId]`: incremented in `_update` on every transfer, mint included. Anything that is meant to stop applying after a transfer (wave 2 listings, guardian policies) records the epoch when it is created and is invalid once the epoch moves. See [Extension points](#extension-points).
- `tokenURI` is empty in wave 1. A renderer is UI work and not security relevant.

### PositionFactory

- Constructor deploys `PositionNFT` and the `PositionVault` implementation, so both can hold the factory, NFT and Mezo core addresses as immutables. No setter, no owner, no upgrade path.
- `openPosition(debt, upperHint, lowerHint, maxFee) payable`, `nonReentrant`: clones the implementation, calls the clone's factory-only `initializeAndOpen`, emits `PositionCreated`, and **mints the NFT last**. The first open cannot use the normal holder check, because the token does not exist yet, so the holder is passed in and the minted MUSD goes to them. `_safeMint` calls the receiver, so a contract holder runs code at the very end, after the position is complete (THREAT_MODEL T18).
- `createPosition()` is not offered. A vault with no trove can come from a closed, redeemed or liquidated trove and then be reopened by its holder, so it needs no separate creation path.
- Events: `PositionCreated(tokenId, vault, holder)`.

### PositionVault

One clone per position. It is the trove borrower, so `BorrowerOperations` sees `msg.sender == vault`.

Authorisation is one rule: **the caller must be `nft.ownerOf(tokenId)` at the moment of the call**. The vault stores no operator, no delegate and no allowance of its own. ERC-721 per-token approvals and operators can move the NFT, but they cannot move funds in the vault. There is nothing to reset on transfer because there is nothing stored.

Operations (all `nonReentrant`, all `onlyHolder`, funds always go to `msg.sender`, never to a caller-supplied address):

| Function | Wraps | Notes |
|---|---|---|
| `initializeAndOpen(id, holder, debt, upper, lower, maxFee)` payable | `openTrove` | Factory only, once, in the clone transaction. |
| `open(debt, upper, lower, maxFee)` payable | `openTrove` | `msg.value` is collateral. Reverts if the borrowing fee exceeds `maxFee`. Minted MUSD is forwarded to the holder. |
| `addCollateral(upper, lower)` payable | `addColl` | |
| `withdrawCollateral(amount, upper, lower)` | `withdrawColl` | BTC forwarded to the holder. |
| `borrow(amount, upper, lower, maxFee)` | `withdrawMUSD` | Same fee bound as `open`. MUSD forwarded. |
| `repay(amount, upper, lower)` | `repayMUSD` | Pulls MUSD from `msg.sender` (needs the holder's allowance to the vault). |
| `repayWithPermit(amount, upper, lower, deadline, v, r, s)` | `repayMUSD` | Same, with an EIP-2612 signature. The permit is wrapped in `try/catch`, so a front-run permit cannot block it (T21). |
| `adjust(collWithdrawal, debtChange, isIncrease, upper, lower, maxFee)` payable | `adjustTrove` | |
| `refinance(upper, lower, maxFee, minRateDropBps)` | `refinance` | See [Refinance wrapper](#refinance-wrapper). |
| `close()` | `closeTrove` | Pulls `debt - 200e18` MUSD from the holder, BTC forwarded to the holder. |
| `closeWithPermit(deadline, v, r, s)` | `closeTrove` | Same, with a permit for the exact close cost. |
| `claimSurplus()` | `claimCollateral` | BTC left by a redemption or liquidation. |
| `sweep(token)` | none | Sends any ERC-20 or native balance, for example a forced send, to the holder. |

BTC handling:

- `receive()` accepts native BTC only from `ActivePool` and `CollSurplusPool` and does nothing else. No state read, no state write, no external call. This is the callback surface Mezo's own code marks as "re-entry is fine".
- Forwarding uses a balance delta: record `address(this).balance` (minus `msg.value`) before the Mezo call and send the increase afterwards. Forced sends that arrive before the call stay in the vault until `sweep`.
- MUSD is pulled from `msg.sender` only, never from a stored address. A holder who sold the position cannot have their MUSD pulled by the new holder's call, because the allowance that matters is the caller's own.

Initialisation:

- The implementation contract disables initialisation in its constructor.
- `initialize(tokenId)` is callable once and only by the factory (immutable check), in the same transaction as the clone.

### PositionLens

Stateless view contract, no admin. Reads only `getEntireDebtAndColl`, `getCurrentICR`-equivalent maths and the other views listed below. It never calls `getTroveColl` or `getTroveDebt`, which exclude pending redistribution.

`positionInfo(vault)` returns:

| Field | Source |
|---|---|
| holder, tokenId, active | NFT, TroveManager status |
| coll, principal, interest (all including pending and accrued) | `getEntireDebtAndColl` |
| price | `PriceFeed.fetchPrice()` |
| icr | `coll * price / (principal + interest)`, same as `LiquityMath._computeCR` |
| equityUsd | `coll * price / 1e18 - debt` (signed) |
| lockedRateBps, globalRateBps, spreadBps (signed) | `TroveManager.getTroveInterestRate`, `InterestRateManager.interestRate` |
| annualSpreadMusd (signed) | `principal * (globalRateBps - lockedRateBps) / 10_000`, rounded toward zero. Undiscounted, current rate only. |
| claimableSurplus | `CollSurplusPool.getCollateral(vault)` |
| refinanceFeeEstimate | `netDebt * refinancingFeePercentage / 100 * borrowingRate / 1e18` |
| priceOk | `fetchPrice` did not revert and returned non-zero. When false, price-dependent fields are zero and `redeemable` and `canClose` are false. |
| redeemable | `icr >= MCR` and the trove is in `SortedTroves` |
| recoveryMode, canClose | `checkRecoveryMode(price)`; `canClose` also needs an active trove and more than one trove in the list (THREAT_MODEL T19) |

`redemptionBuffer(vault, maxSteps)` returns `(buffer, eligibleAhead, steps, complete)`.

Walk: `SortedTroves.getLast()`, then `getPrev` until the vault is reached or `maxSteps` is used. For each trove it calls `getEntireDebtAndColl` once and computes ICR locally. Troves with ICR below MCR are skipped, as `redeemCollateral` skips them. Each eligible trove adds `debt - 200e18`. Measured cost is in [VERIFICATION.md](VERIFICATION.md#gas-of-the-buffer-walk).

Semantics, which any caller must respect:

- `complete == true`: the walk reached the vault. `buffer` is the exact amount of MUSD that a redeemer would have to burn, at this block, before the vault's trove is reached.
- `complete == false`: `buffer` is a **lower bound**. It proves the buffer is large. It never proves it is small.
- `bufferAtLeast(vault, threshold, maxSteps)` returns `Verdict.Above | Below | Unknown`. It stops early with `Above` as soon as the running sum reaches `threshold`. It returns `Below` only for a complete walk. A step cap that runs out gives `Unknown`.
- Every eligible trove ahead contributes at least its net debt, and net debt is at least `minNetDebt` when the trove is opened or changed (`BorrowerOperations.sol:645,856`). Live `minNetDebt` is 1800 MUSD, so reaching a threshold `T` takes about `T / 1800` eligible troves. Governance can change `minNetDebt` (floor 50 MUSD, `BorrowerOperations.sol:97`), so the Lens does not assume it: it sums actual debts and the early exit is exact regardless of parameters.
- Skipped troves (ICR below MCR) are not bounded by that argument. A long run of liquidatable troves at the tail consumes steps without adding to the buffer, so a capped check can return `Unknown`.
- **Any future on-chain trigger must use complete-walk semantics.** A keeper action that fires on "buffer below X" must have `complete == true` (or `Below`) in the transaction that executes it. `Unknown` and `Above` never fire it.

The buffer ignores that troves ahead can change before a redemption lands (top-ups, closes, other redemptions), and that sort order uses NICR, which ignores accrued interest and pending redistribution. It is a point-in-time estimate, not a guarantee. The UI says so.

## Refinance wrapper

`PositionVault.refinance(upper, lower, maxFee, minRateDropBps)`:

1. Read `lockedRate = TroveManager.getTroveInterestRate(vault)` and `globalRate = InterestRateManager.interestRate()`.
2. Require `globalRate + max(minRateDropBps, 1) <= lockedRate`. Mezo's `refinance` accepts a higher global rate and would raise the position's rate; this check makes that impossible through KEEL.
3. Record total debt (`principal + interest` from `getEntireDebtAndColl`) before.
4. Call `BorrowerOperations.refinance(upper, lower)`.
5. Require `debtAfter - debtBefore <= maxFee`. Both reads are in the same block, so the difference is the refinance fee (`BorrowerOperations.sol:1032-1037`).
6. Require the trove's new rate equals `globalRate`.

A strict improvement of at least one basis point is always enforced. `minRateDropBps` lets the wave 2 guardian demand more.

## Reading rules

- All debt and collateral reads in the Lens, the vault checks and (wave 2) the marketplace go through `getEntireDebtAndColl`. Plain `getTroveDebt` and `getTroveColl` are not used, because they exclude pending redistribution (VERIFICATION section 5).
- ICR is computed locally from those values and the price, using the same integer formula as Mezo, so results agree with `getCurrentICR`.
- Every number a settlement depends on is read inside the settling transaction.

## Why Foundry

- Fuzzing and stateful invariant testing are first-class and fast. The brief asks for fuzz, invariants and fork tests.
- Fork tests against matsnet use the real MUSD proxies. MUSD's own Hardhat tooling is not needed: KEEL only calls deployed contracts through interfaces.
- Constraint: Mezo runs `london`, so `foundry.toml` sets `evm_version = "london"` and `solc_version = "0.8.24"` (the version MUSD pins). No `PUSH0`, no transient storage, no `mcopy`.
- Constraint found in phase 0: `PriceFeed.fetchPrice` calls a chain precompile (`0x7b7c000000000000000000000000000000000015`) that forge's EVM does not implement. Fork tests mock `fetchPrice` with `vm.mockCall`.

## Test layers

See [TEST_PLAN.md](TEST_PLAN.md) for status and numbers.

1. **Local deployment of the real MUSD contracts.** `lib/musd` is a git submodule pinned to `aa25fd6`. `test/helpers/MezoFixture.sol` deploys every core contract behind a proxy and wires it the way Mezo's deploy scripts do. The oracle is the only fake: the real `PriceFeed` reads the `MockAggregator` that ships in the Mezo repository. Unit, fuzz, invariant and state-machine tests all run here, so they exercise real redemption, liquidation, redistribution and Recovery Mode. There is no hand-written mock of the Mezo core.
2. **matsnet fork tests, a small final layer.** Pinned to one block so the RPC cache makes reruns cheap. They check that the live proxies behave as the pinned source does. `PriceFeed.fetchPrice` is mocked there, because the live feed calls a chain precompile that forge does not implement.

## Dependencies

- OpenZeppelin Contracts, pinned to a release that compiles under `london` with 0.8.24. Used: `ERC721Enumerable`, `Clones`, `ReentrancyGuard`, `SafeERC20`.
- `forge-std` for tests.
- Mezo contracts are called through small interfaces in `src/interfaces/mezo/`. The Mezo repository is not vendored.

## Extension points

What wave 2 builds on:

- `PositionNFT.transferEpoch(tokenId)`. A wave 2 listing stores `(tokenId, epoch)` and is void if the epoch changed. A guardian policy stored in the guardian contract is keyed by `(tokenId, epoch)`, so a transfer wipes it without the vault knowing.
- A marketplace is an ordinary ERC-721 operator. It does not need a vault hook. It escrows nothing: it checks the committed bounds against `getEntireDebtAndColl` at settlement and, in the same transaction, takes MUSD from the buyer and calls `transferFrom` on the NFT.
- The guardian does need a change to the vault. The wave 1 vault accepts only `ownerOf`, so a guardian contract cannot act on it. Wave 2 ships `PositionVault` v2 behind a new factory, adding one caller class: a guardian chosen by the holder, valid only while `transferEpoch` equals the epoch it was set in, and limited to a fixed list of functions (bounded refinance, top-up from a reserve). Vault v2 is a strict superset of the v1 interface: every v1 function keeps its signature and behaviour, so the marketplace and the UI work against either. Wave 1 positions keep working and can use the marketplace, but they do not get the guardian unless the holder migrates. I chose this over pre-building a delegate slot in wave 1, because an unused privileged path is attack surface with no wave 1 benefit.

## Not in scope

- Stability Pool deposits, MUSD savings, PCV interaction.
- Cross-chain positions. MUSD on other chains has no CDP (VERIFICATION section 9).
- Using `BorrowerOperationsSignatures`: it checks plain ECDSA, so a contract borrower cannot sign (VERIFICATION section 7).
