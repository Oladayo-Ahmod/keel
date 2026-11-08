# Architecture

Trozu wraps a Mezo MUSD trove in a minimal-proxy vault and represents the vault as an ERC-721. Whoever holds the NFT controls the trove. Moving the NFT moves the whole position: collateral, debt and the locked interest rate. On top of that sit a marketplace that sells positions with the buyer's bounds checked at settlement, and a guardian that lives in the vault and can add to a position inside limits its holder set. A keeper script triggers the guardian, and a web app, an SDK, an MCP server and an alerts script sit around the contracts.

Facts about MUSD that this design depends on are cited in [VERIFICATION.md](VERIFICATION.md). The reasons for each choice are numbered in [DECISIONS.md](DECISIONS.md), and the numbers in brackets below point there. Threats are in [THREAT_MODEL.md](THREAT_MODEL.md). What was deployed and run is in [DEPLOYMENTS.md](DEPLOYMENTS.md), [PROOF.md](PROOF.md) and [ROUNDTRIP.md](ROUNDTRIP.md).

## Scope

| Part | What it is | Status |
|---|---|---|
| **Original contracts** | `PositionFactory`, `PositionVault`, `PositionNFT`, `PositionLens` | Deployed on Mezo testnet, unchanged, exact Sourcify matches. The Trozu contracts are copies of them with additions, so their source stays byte for byte as deployed (39). |
| **Trozu contracts** | `TrozuFactory`, `TrozuVault`, `TrozuNFT`, `TrozuMarket`, and a `PositionLens` bound to the Trozu NFT | Deployed on Mezo testnet on 2026-11-06, exact Sourcify matches. |
| **Keeper** | `keeper/`, a TypeScript script and a GitHub Actions schedule | Triggers the guardian. |
| **Web app** | `web/`, Next.js | Reads the chain, builds and sends transactions through the user's wallet. |
| **Packages** | `packages/sdk`, `packages/mcp`, `packages/alerts` | Read the chain. The SDK builds unsigned transactions. None signs or sends. |

The Trozu vault is a strict superset of the original vault interface: every original function keeps its signature and behaviour, so the app and the SDK treat both the same (24). The marketplace and the guardian are only for Trozu positions. `TrozuMarket` is bound to one NFT contract, the Trozu NFT, and it reads the vault's guardian reserve, which an original vault does not have. An original position keeps working as before but cannot be sold here and has no guardian.

## Components

```
                    holder (EOA or contract)
                      |   ownerOf(tokenId)
                      v
 TrozuFactory ----mints----> TrozuNFT (ERC-721, enumerable, transferEpoch, vaultOf)
      |                          ^   ^
      | clone + initialize       |   | ownerOf, getApproved, transferEpoch
      v                          |   |
 TrozuVault (EIP-1167 clone, one per position)      TrozuMarket (signed listings, bounds at settlement)
      |  msg.sender = vault = trove borrower              |  reads the trove and the reserve, pays seller and fee,
      |  holds the guardian reserve, policy, execute()    |  then moves the NFT
      v                                                   v
 Mezo MUSD core: BorrowerOperations, TroveManager, SortedTroves, ActivePool, CollSurplusPool, MUSD, PriceFeed

 PositionLens (stateless views) ---> reads vault, TroveManager, SortedTroves, PriceFeed, InterestRateManager
 TrozuVault.execute() ---> LENS.bufferAtLeast (redemption defense only)

 off chain:  keeper --execute()--> TrozuVault          web app, SDK, MCP, alerts --read--> lens, market, vault, logs
```

The original contracts have the same shape without the market, the reserve and the guardian: `PositionFactory` mints `PositionNFT` and clones `PositionVault`.

### PositionNFT and TrozuNFT

- OpenZeppelin `ERC721Enumerable`. Enumeration lets the UI list a wallet's positions without an indexer (9).
- `mint` is callable only by the factory (immutable address, set in the factory constructor).
- `vaultOf[tokenId]`, written at mint.
- `transferEpoch[tokenId]`: incremented in `_update` on every transfer, mint included (10). Anything that is meant to stop applying after a transfer records the epoch when it is created and is invalid once the epoch moves. The marketplace does this for listings and the guardian for policies, see below.
- Names: `PositionNFT` is "KEEL Position" (`KEEL`); `TrozuNFT` is "Trozu Position" (`TROZU`).
- `tokenURI` is empty. A renderer is UI work and not security relevant.

### PositionFactory and TrozuFactory

- Constructor deploys the NFT, the lens and the vault implementation, so each can hold the factory, NFT and Mezo core addresses as immutables. No setter, no owner, no upgrade path (16).
- `openPosition(debt, upperHint, lowerHint, maxFee) payable`, `nonReentrant`: clones the implementation, calls the clone's factory-only `initializeAndOpen`, emits `PositionCreated(tokenId, vault, holder)`, and **mints the NFT last** (21). The first open cannot use the normal holder check, because the token does not exist yet, so the holder is passed in and the minted MUSD goes to them. `_safeMint` calls the receiver, so a contract holder runs code at the very end, after the position is complete (T18).
- `TrozuFactory` also takes `debtCap`, an optional ceiling on a position's total debt fixed at deployment (0 means none), passed to every vault (40). It counts positions in `totalPositions`.
- `createPosition()` is not offered. A vault with no trove can come from a closed, redeemed or liquidated trove and then be reopened by its holder, so it needs no separate creation path.

### PositionVault and TrozuVault

One clone per position. It is the trove borrower, so `BorrowerOperations` sees `msg.sender == vault` (3).

Authorisation is one rule: **the caller must be `nft.ownerOf(tokenId)` at the moment of the call** (4). The vault stores no operator, no delegate and no allowance of its own. ERC-721 per-token approvals and operators can move the NFT, but they cannot move funds in the vault. There is nothing to reset on transfer because there is nothing stored. The one exception in the Trozu vault is `execute`, which anyone can call, and which only does what the holder's own policy allows (see [The guardian](#the-guardian)).

Operations (all `nonReentrant`, all `onlyHolder` except `execute`, funds always go to `msg.sender`, never to a caller-supplied address (5)):

| Function | Wraps | Notes |
|---|---|---|
| `initializeAndOpen(id, holder, debt, upper, lower, maxFee)` payable | `openTrove` | Factory only, once, in the clone transaction. |
| `open(debt, upper, lower, maxFee)` payable | `openTrove` | `msg.value` is collateral. Reverts if the borrowing fee exceeds `maxFee`. Minted MUSD is forwarded to the holder. |
| `addCollateral(upper, lower)` payable | `addColl` | |
| `withdrawCollateral(amount, upper, lower)` | `withdrawColl` | BTC forwarded to the holder. |
| `borrow(amount, upper, lower, maxFee)` | `withdrawMUSD` | Same fee bound as `open`. MUSD forwarded. |
| `repay(amount, upper, lower)` | `repayMUSD` | Pulls MUSD from `msg.sender` (needs the holder's allowance to the vault). |
| `repayWithPermit(amount, upper, lower, deadline, v, r, s)` | `repayMUSD` | Same, with an EIP-2612 signature. The permit is wrapped in `try/catch`, so a front-run permit cannot block it (22, T21). |
| `adjust(collWithdrawal, debtChange, isIncrease, upper, lower, maxFee)` payable | `adjustTrove` | |
| `refinance(upper, lower, maxFee, minRateDropBps)` | `refinance` | See [Refinance wrapper](#refinance-wrapper). Manual only. |
| `close()` | `closeTrove` | Pulls `debt - 200e18` MUSD from the holder, BTC forwarded to the holder. |
| `closeWithPermit(deadline, v, r, s)` | `closeTrove` | Same, with a permit for the exact close cost. The app does not use it (43). |
| `claimSurplus()` | `claimCollateral` | BTC left by a redemption or liquidation. |
| `sweep(token)` | none | Sends any ERC-20 or native balance, for example a forced send, to the holder. In the Trozu vault it never touches the guardian reserve. |

Only in `TrozuVault`: `fundReserveBtc`, `fundReserveMusd`, `fundReserveMusdWithPermit`, `withdrawReserveBtc`, `withdrawReserveMusd`, `setPolicy`, `clearPolicy`, `policy`, `policyLive`, `preview` and `execute`, and the debt cap check after opens, borrows and debt-increasing adjusts (40).

BTC handling:

- `receive()` accepts native BTC only from `ActivePool` and `CollSurplusPool` and does nothing else (7). No state read, no state write, no external call. This is the callback surface Mezo's own code marks as "re-entry is fine". Reserve BTC comes in through `fundReserveBtc`, not through `receive`.
- Forwarding uses a balance delta (8): record `address(this).balance` (minus `msg.value`) before the Mezo call and send the increase afterwards. Forced sends that arrive before the call stay in the vault until `sweep`.
- MUSD is pulled from `msg.sender` only, never from a stored address (6). A holder who sold the position cannot have their MUSD pulled by the new holder's call, because the allowance that matters is the caller's own.

Initialisation:

- The implementation contract disables initialisation in its constructor.
- `initialize(tokenId)` is callable once and only by the factory (immutable check), in the same transaction as the clone.

### PositionLens

Stateless view contract, no admin. Reads only `getEntireDebtAndColl`, `getCurrentICR`-equivalent maths and the other views listed below. It never calls `getTroveColl` or `getTroveDebt`, which exclude pending redistribution (12). One lens is deployed per NFT: the Trozu factory creates its own, bound to the Trozu NFT. An app that shows both kinds of position has to ask the lens of the position's own NFT, because the same token id exists in both (see [web app](#web-app)).

`positionInfo(tokenId)` returns:

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
| recoveryMode, canClose | `checkRecoveryMode(price)`; `canClose` also needs an active trove and more than one trove in the list (T19) |

`redemptionBuffer(tokenId, maxSteps)` returns `(buffer, eligibleAhead, steps, complete, inList)`.

Walk: `SortedTroves.getLast()`, then `getPrev` until the vault is reached or `maxSteps` is used. For each trove it calls `getEntireDebtAndColl` once and computes ICR locally. Troves with ICR below MCR are skipped, as `redeemCollateral` skips them. Each eligible trove adds `debt - 200e18`. Measured cost is in [VERIFICATION.md](VERIFICATION.md#gas-of-the-buffer-walk). The default cap is 100 steps (18).

Semantics, which any caller must respect (13):

- `complete == true`: the walk reached the vault. `buffer` is the exact amount of MUSD that a redeemer would have to burn, at this block, before the vault's trove is reached.
- `complete == false`: `buffer` is a **lower bound**. It proves the buffer is large. It never proves it is small.
- `bufferAtLeast(tokenId, threshold, maxSteps)` returns `Verdict.Above | Below | Unknown`. It stops early with `Above` as soon as the running sum reaches `threshold`. It returns `Below` only for a complete walk. A step cap that runs out gives `Unknown`.
- Every eligible trove ahead contributes at least its net debt, and net debt is at least `minNetDebt` when the trove is opened or changed (`BorrowerOperations.sol:645,856`). Live `minNetDebt` is 1800 MUSD, so reaching a threshold `T` takes about `T / 1800` eligible troves. Governance can change `minNetDebt` (floor 50 MUSD, `BorrowerOperations.sol:97`), so the lens does not assume it: it sums actual debts and the early exit is exact regardless of parameters.
- Skipped troves (ICR below MCR) are not bounded by that argument. A long run of liquidatable troves at the tail consumes steps without adding to the buffer, so a capped check can return `Unknown`.
- **Any on-chain trigger uses complete-walk semantics.** The guardian's redemption defense fires only on `Below`. `Unknown` and `Above` never fire it (44).

The buffer ignores that troves ahead can change before a redemption lands (top-ups, closes, other redemptions), and that sort order uses NICR, which ignores accrued interest and pending redistribution. It is a point-in-time estimate, not a guarantee. The UI says so.

## Refinance wrapper

`refinance(upper, lower, maxFee, minRateDropBps)` on either vault:

1. Read `lockedRate = TroveManager.getTroveInterestRate(vault)` and `globalRate = InterestRateManager.interestRate()`.
2. Require `globalRate + max(minRateDropBps, 1) <= lockedRate`. Mezo's `refinance` accepts a higher global rate and would raise the position's rate; this check makes that impossible through Trozu (11).
3. Record total debt (`principal + interest` from `getEntireDebtAndColl`) before.
4. Call `BorrowerOperations.refinance(upper, lower)`.
5. Require `debtAfter - debtBefore <= maxFee`. Both reads are in the same block, so the difference is the refinance fee (`BorrowerOperations.sol:1032-1037`).
6. Require the trove's new rate equals `globalRate`.

A strict improvement of at least one basis point is always enforced, and `minRateDropBps` lets a holder demand more. **The guardian never calls it** (30): the global rate has never moved on mainnet, so automating refinance would be a feature with no data behind it.

## TrozuMarket

A peer-to-peer sale of Trozu positions for MUSD. No owner, no setters, no pause. It holds nothing between calls.

**Non-custodial (26).** The position stays in the seller's wallet until a buyer settles. The seller approves the market on the NFT (one token, or all). A sale moves MUSD first and the NFT last, so a failed sale moves nothing.

**Listing.** An EIP-712 order (domain `TrozuMarket`, version `1`), also valid from a contract wallet through ERC-1271 (OpenZeppelin `SignatureChecker`):

| Field | Meaning |
|---|---|
| `seller`, `tokenId` | Who sells what. |
| `epoch` | The NFT's `transferEpoch` when it was signed. A transfer, even away and back, kills the listing. |
| `startPrice`, `endPrice` | Equal for a fixed price. Otherwise the price falls in a straight line from `startPrice` at `startTime` to `endPrice` at `endTime` and stays there until `deadline`. `priceAt` rounds the drop down, so the price rounds up against the buyer. |
| `startTime`, `endTime`, `deadline` | Times. |
| `nonce` | The seller's `sellerNonce` when signed. `cancelAll()` raises it and kills every listing at once. |
| `salt` | Makes two otherwise equal listings distinct. |

**`check(listing, signature)`** returns one of 13 states, in the order the contract tests them: `Ok`, `Filled`, `Cancelled`, `BadParams`, `NotStarted`, `Expired`, `NonceRevoked`, `BadSignature`, `NotOwner`, `NotApproved`, `StaleEpoch`, `TroveInactive`, `NoCollateral`. `announce` and `buy` both run it.

**Discovery is an event, not a server (27).** `announce(listing, signature)` re-runs `check` and emits `ListingAnnounced` with the signature, so any indexer, and the app, can rebuild the order book from logs. Only a listing that would settle right now is accepted, so a spammer needs the seller's signature. `cancel(listing)` (seller only) and `cancelAll()` emit events too.

**Settlement, `buy(listing, signature, bounds, recipient, permit)`**, one transaction (29):

1. `check` must say `Ok`.
2. Bounds are checked against Mezo's numbers **in this block**: the expected epoch, a minimum collateral, a maximum debt (`principal + interest` from `getEntireDebtAndColl`), a locked rate inside `[minRateBps, maxRateBps]`, and a minimum guardian reserve in BTC and in MUSD (the reserve moves with the position, so a seller who empties it after signing makes the sale fail).
3. The price is read at `block.timestamp` and must not exceed `maxPrice`. The fee is `price * FEE_BPS / 10_000`, rounded up.
4. The listing is marked `Filled` before anything moves.
5. An optional EIP-2612 permit over `maxPrice` is tried in a `try/catch`.
6. The buyer pays `price`, split exactly: `price - fee` to the seller, `fee` to `FEE_RECIPIENT`.
7. `NFT.safeTransferFrom(seller, recipient, tokenId)` runs last. A contract recipient therefore runs code only after the money has moved and the listing is filled.
8. `Sold(hash, seller, buyer, tokenId, recipient, price, fee)` is emitted.

**Fee (28).** `FEE_BPS` and `FEE_RECIPIENT` are constructor arguments and immutable. The constructor reverts above `MAX_FEE_BPS = 100` (1%). The deployment uses 25 bps and the deployer as recipient. The seller bears the fee in effect: the buyer pays the listed price, and the seller receives it minus the fee.

**Errors:** `ListingInvalid(state)`, `NotSeller`, `AlreadyClosed`, `EpochMismatch`, `CollateralBelowMin`, `DebtAboveMax`, `RateOutOfRange`, `PriceAboveMax`, `ReserveBelowMin`, `FeeTooHigh`, `ZeroAddress`. Each one the proof run provoked is listed in [PROOF.md](PROOF.md).

## The guardian

The guardian is not a separate contract. It is state and functions in `TrozuVault`, so it needs no extra caller class and no delegate slot in the vault's authorisation rule. The holder funds a reserve and sets a policy. Anyone may call `execute`, and it only acts if the vault's own planner says the policy calls for it.

**Reserve (34, 35).** `reserveBtc` and `reserveMusd` are explicit state. The reserve stays in the vault as plain BTC and MUSD, not in the MUSD savings vault (see [INTEGRATION_SCAN.md](INTEGRATION_SCAN.md)). Between calls the vault holds exactly its reserve plus anything forced in, and `sweep` returns only the excess. The holder can withdraw the reserve at any time, whatever the policy says. It moves with the NFT, which is why a buyer pins it.

**Policy.** One per vault, set by the holder, stamped with `transferEpoch` (37):

| Field | Meaning |
|---|---|
| `floorIcr` | Act when the ratio is below this. Must be above 110%. |
| `targetIcr` | Restore towards this, never past it (32). Above the floor, at most 500%. |
| `maxActionBtc`, `maxActionMusd` | Largest single action. At least one must be non-zero. |
| `periodCapBtc`, `periodCapMusd` | Most that may leave the reserve in one period, tip included. Not below the single-action cap. |
| `keeperTipBtc` | Paid from the reserve on success, at most `MAX_KEEPER_TIP = 0.0001 BTC`, and below the BTC period cap (36). |
| `bufferFloorMusd`, `maxWalkSteps` | Redemption defense. 0 turns it off. If set, `maxWalkSteps` must be non-zero (at most 100) and `maxActionBtc` non-zero. |
| `period` | Between one hour and 30 days. |

`setPolicy` validates all of that and reverts with `BadPolicy(reason)`. It replaces any earlier policy and restarts the spending window (`periodStart`, `spentBtc`, `spentMusd`). `clearPolicy` deletes it. `policyLive()` is true only if a policy exists and its epoch equals the NFT's current `transferEpoch`, so a transfer, including away and back, switches the old policy off with no write.

**The planner.** `preview()` and `execute()` call one function, `_plan()`, so a preview is exactly what an execution would do (33). It returns `Plan { kind, reason, amount, tip, icr, resetWindow }`. Its steps, in order:

1. No policy: `NoPolicy`. Policy from an earlier holder: `PolicyStale`. No open trove: `TroveInactive`. Dead price feed: `NoPrice`.
2. The ratio an action has to reach is 110%, or in Recovery Mode the system ratio if that is higher. This came from a review finding (see [REVIEW.md](REVIEW.md)).
3. No debt, or a ratio at or above the target, or above the floor with defense off: `Healthy`.
4. Above the floor with defense on: ask the lens `bufferAtLeast(tokenId, bufferFloorMusd, maxWalkSteps)`. `Above` gives `Healthy`, `Unknown` gives `BufferUnknown`, only `Below` goes on (44).
5. The spending window: it is fresh if `period` has passed since `periodStart`, and then spent amounts count as zero. The tip is `keeperTipBtc` only if the reserve and the BTC allowance both cover it.
6. BTC first: the most it can add is the smallest of the reserve less the tip, the BTC allowance less the tip, the single-action cap, and what restores the target ratio. It is offered only if it leaves the ratio at or above the line in step 2. Above the floor it is `DefendBtc`, below it `TopUpBtc`.
7. Then, only for a breach of the floor, a MUSD repayment: the smallest of the MUSD reserve, the MUSD allowance, the single-action cap, the debt above Mezo's minimum net debt, and what restores the target. Offered under the same rule.
8. If an action was possible but would leave the position too low for Mezo to accept: `BelowMinimum`. Otherwise `NoReserve`. The planner never offers what Mezo would reject (33).
9. The tip is paid only if the action moves at least `MIN_ACTION_PER_TIP = 10` times the tip in BTC value, so dust actions pay nothing. This also came from a review finding.

**`execute(upperHint, lowerHint)`**, `nonReentrant`: runs the plan and reverts `NothingToDo(reason)` if the kind is `None`, so a keeper that is too early pays gas and nothing else. Otherwise: optionally start a new window, update the reserve and spent amounts, emit `GuardianAction(keeper, kind, amount, tip, icrBefore)`, and only then call Mezo (`addColl` or `repayMUSD`) and pay the tip to `msg.sender`. At the end it checks the vault's balances still cover the reserve (`ReserveInvariant`). Hints are untrusted: Mezo uses them as a starting point for its sorted-list search (38). Without hints a call costs several times the gas, see [INTEGRATIONS.md](INTEGRATIONS.md).

**Hard limits in code, whatever a policy says:** `MAX_KEEPER_TIP = 0.0001 BTC`, `MIN_ACTION_PER_TIP = 10`, `MAX_WALK_STEPS = 100`, `MAX_TARGET_ICR = 500%`, `MIN_PERIOD = 1 hour`, `MAX_PERIOD = 30 days`.

**What it does not do:** refinance (30), act on a buffer it could not prove (44), rescue a position already too low for one capped action to lift over the line, or run itself. Something has to call `execute`, and that is the keeper or anyone else.

## Keeper

`keeper/` is a TypeScript script. It never works out a plan itself: it asks each vault's own `preview` and sends `execute` only where the answer is not `None`.

1. **Discover.** Read `PositionCreated` logs from the factory and `PolicySet` logs from anywhere, in windows of at most 10,000 blocks because the public RPC refuses more. Anyone can emit a `PolicySet` topic, so only vaults the factory created are trusted.
2. **Ask.** For each vault: skip if the policy is not live, then call `preview`. A `None` plan is skipped with the planner's reason.
3. **Send.** Look up sorted-list hints (an optimisation: if the lookup fails the call goes without), estimate gas, and send `execute`. The gas limit is the estimate plus 20%, never under 6M and never over 9.5M, because the node's `eth_estimateGas` is unreliable (42). If the estimate itself reverts (state moved, or another keeper got there first) the vault is skipped.
4. **Report.** One outcome per vault: skipped with a reason, would-send (dry run), sent with the transaction, or failed. One vault failing never stops the others.

Transient errors are retried with exponential backoff. A revert from the contract is an answer and is not retried. The key comes from `KEEPER_PRIVATE_KEY`; without `--dry-run` the script refuses to start without it. Addresses come from `web/src/config/deployment.v2.json`. The workflow `.github/workflows/keeper.yml` runs it every 15 minutes and falls back to a dry run when the secret is missing. `npm run proof` in `keeper/` runs the whole lifecycle once on testnet and writes [PROOF.md](PROOF.md) and `docs/proof.json`.

## Web app

`web/` is a Next.js app. It reads through the lens and the market's event log, builds each transaction, simulates it, and has the user's wallet sign. It holds no key.

- **Reads** are paired with the head block of the node that answered and retried if that node is behind, because the public RPC can serve state from nodes far behind the chain. Stale data is flagged and sending is blocked.
- **Writes** all go through one hook that sets an explicit gas limit (42, 47). Hints are computed at the confirm step. A close approves slightly more than it takes and then resets the approval (43).
- **Two kinds of position.** The Trozu positions and the original ones are read through their own lenses (`web/src/lib/lens.ts`), because the same token id exists in both NFT contracts.
- **Pages.** The home page (positions, market, guardian), a public page and share image per position, `/stats` (counts read from event logs), `/proof` and `/break-it` (rendered from `web/src/content/*.json`).
- **What-if simulator.** A TypeScript port of `_plan` run on a position that does not exist yet. It is checked against hundreds of states the contract itself answered (see [REVIEW.md](REVIEW.md)); the one thing the app cannot know is the system ratio at a price that has not happened.
- A test-only wallet connector exists behind `NEXT_PUBLIC_E2E=1` and is checked to be absent from the production build (46).

More in [web.md](web.md).

## Packages

All three read the chain through `viem`, take no key, and are built from this repository.

- **`@trozu/sdk`** exposes `lens`, `market`, `guardian`, `tx`, `simulate` and `hints`. `tx.*` builds `{ chainId, to, data, value, gas }` for a wallet to sign and never signs. Its gas table matches the app's, and a test fails if they differ. Its generated ABIs and deployment record are checked against `abi/v2` and `deployment.v2.json`.
- **`@trozu/mcp`** serves six tools over stdio (`get_position`, `list_listings`, `quote_listing`, `guardian_status`, `simulate_action`, `build_tx`) to MCP clients. Every tool is read-only. Creating a listing is not offered, because it needs a seller's signature. The chain is treated as untrusted input.
- **`@trozu/alerts`** posts to a webhook when a guarded position is near its floor or the keeper acted. Its only secret is the webhook URL.

See [INTEGRATIONS.md](INTEGRATIONS.md) for what was and was not tested.

## Reading rules

- All debt and collateral reads in the lens, the vault checks and the marketplace go through `getEntireDebtAndColl`. Plain `getTroveDebt` and `getTroveColl` are not used, because they exclude pending redistribution (VERIFICATION section 5).
- ICR is computed locally from those values and the price, using the same integer formula as Mezo, so results agree with `getCurrentICR`.
- Every number a settlement depends on is read inside the settling transaction.

## Why Foundry

- Fuzzing and stateful invariant testing are first-class and fast. The brief asks for fuzz, invariants and fork tests.
- Fork tests against Mezo use the real MUSD proxies. MUSD's own Hardhat tooling is not needed: Trozu only calls deployed contracts through interfaces.
- Constraint: Mezo runs `london`, so `foundry.toml` sets `evm_version = "london"` and `solc_version = "0.8.24"` (the version MUSD pins). No `PUSH0`, no transient storage, no `mcopy`.
- Constraint found in phase 0: `PriceFeed.fetchPrice` calls a chain precompile (`0x7b7c000000000000000000000000000000000015`) that forge's EVM does not implement. Fork tests mock `fetchPrice` with `vm.mockCall`.

## Test layers

See [TEST_PLAN.md](TEST_PLAN.md) for status and numbers.

1. **Local deployment of the real MUSD contracts.** `lib/musd` is a git submodule pinned to `aa25fd6`. `test/helpers/MezoFixture.sol` deploys every core contract behind a proxy and wires it the way Mezo's deploy scripts do. The oracle is the only fake: the real `PriceFeed` reads the `MockAggregator` that ships in the Mezo repository. Unit, fuzz, invariant and state-machine tests all run here, so they exercise real redemption, liquidation, redistribution and Recovery Mode. There is no hand-written mock of the Mezo core.
2. **Trozu tests.** The market and the guardian have their own suites and a state-machine invariant handler that interleaves holder actions, transfers, listings, sales, reserve moves, keeper calls and price moves. The original vault tests are re-run against the Trozu vault (`test/v2/regression/`) to prove the superset claim. One test writes hundreds of guardian states, each with the contract's own answer, for the web tests to replay.
3. **Mainnet fork tests, a small final layer.** Pinned to block 13,040,764 so the RPC cache makes reruns cheap. They check that the live proxies behave as the pinned source does. `PriceFeed.fetchPrice` is mocked there (41).
4. **TypeScript tests** for the keeper, the app's pure logic, the SDK, the MCP server and the alerts script, against mock chains and a stubbed `fetch`.

## Dependencies

- OpenZeppelin Contracts 5.2.0 (25), pinned to a release that compiles under `london` with 0.8.24. Used: `ERC721Enumerable`, `Clones`, `ReentrancyGuard`, `SafeERC20`, `EIP712`, `SignatureChecker`.
- `forge-std` for tests.
- Mezo contracts are called through small interfaces in `src/interfaces/mezo/`. The Mezo repository is not vendored beyond the test submodule.

## How the pieces rely on each other

- **`transferEpoch` is the one mechanism that makes a transfer void everything tied to the old holder.** The marketplace stamps a listing with it and the vault stamps a policy with it. Neither needs the vault or the market to be told about a transfer, and a move away and back still voids both.
- **The marketplace is an ordinary ERC-721 operator.** It escrows nothing, needs no vault hook, and re-reads the trove from Mezo at settlement.
- **The guardian needed a new vault**, because the original vault accepts only `ownerOf`. It is built into `TrozuVault` behind a new factory (14), not added as a second authorised caller, and the original contracts stay as deployed (39).
- **The lens is shared.** The vault asks it for the redemption verdict, the app and the packages ask it for everything else.

## Not in scope

- Stability Pool deposits, MUSD savings, PCV interaction.
- Cross-chain positions. MUSD on other chains has no CDP (VERIFICATION section 9).
- Using `BorrowerOperationsSignatures`: it checks plain ECDSA, so a contract borrower cannot sign (VERIFICATION section 7, 15).
- Selling an original position, or giving it a guardian.
- A guardian that refinances (30).
- Any component that holds a key. Signing happens in the user's wallet, and the keeper's key lives in its environment.
