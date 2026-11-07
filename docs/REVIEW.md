# AI-assisted adversarial review

**This is not an independent audit.** No human third party reviewed these contracts. It was one pass by a fresh-context AI reviewer (a separate agent run) that was given only an attacker's brief and the source files, and told not to read the docs, the git history or the existing tests. It is a useful second look, not a substitute for a human audit. The contracts remain unaudited.

| | |
|---|---|
| Scope | `src/v2/TrozuMarket.sol`, `src/v2/TrozuVault.sol`, `src/v2/TrozuFactory.sol`, `src/v2/TrozuNFT.sol`, `src/PositionLens.sol` (Mezo's contracts treated as the trusted environment) |
| Method | Read the code, form hypotheses, prove or disprove each with a Foundry test |
| Result | 3 findings with working exploits: 2 Medium, 1 Low. Nothing Critical or High. |
| Exploit tests | [`docs/review/Exploits.t.sol.txt`](review/Exploits.t.sol.txt), kept as text so it does not compile into the suite. All four passed as exploits against the commit that was reviewed. |
| Fixes | One commit each; the new regression tests are listed below. |

## Findings and outcomes

### 1. Recovery mode: the guardian topped up a trove that was still liquidatable (Medium, fixed)

In recovery mode `_plan` skipped the "must leave the trove at 110% or more" check, because Mezo accepts any pure top-up there. But a trove under the system ratio can still be liquidated in recovery mode, so reserve money moved into it was handed to the liquidator. In the PoC the system fell into recovery mode, the vault's trove sat at about 68%, two `execute()` calls took it to 95%, and the same transaction liquidated it and took the 0.02 BTC reserve.

**Fix** (`c7691a8`): in recovery mode an action must lift the trove to at least the system ratio (`getTCR`), or to 110%, whichever is higher, otherwise `execute` is not offered and `preview` returns `BelowMinimum`. Applies to top-ups and repays.
**Regression test:** `Guardian.t.sol::test_inRecoveryModeATopUpMustClearTheSystemRatio`. The reviewer's exploit now reverts with `NothingToDo(BelowMinimum)`.
**Residual:** in a deep crash the guardian will often do nothing because one capped action cannot reach the system ratio. That is the intended behaviour, and it is a limit of the product.

### 2. Dust actions turned the allowance into keeper tips (Medium, fixed)

The tip was a flat amount per action with no link to the action's size, and an action could be one wei. After one legitimate top-up to exactly the target, interest nudged the ratio a hair under it each block, and a keeper could call `execute()` every block for the full tip. In the PoC: 148 tipped actions paid 0.0148 BTC in tips and added about 0.00000006 BTC of collateral. A repay variant at Mezo's minimum debt did the same.

**Fix:** an action must move at least `MIN_ACTION_PER_TIP = 10` times its tip in BTC value, or it still runs but pays no tip. A keeper has no reason to send dust, and a holder is not charged for it.
**Regression tests:** `Guardian.t.sol::testFuzz_aTipIsAlwaysAtMostATenthOfTheValueMoved`, `test_aDustActionRunsButPaysNoTip`, `test_repayDustPaysNoTip`. The reviewer's exploit now pays 0 in tips.
**Residual:** the dust actions themselves are still allowed and consume part of the period allowance, bounded by the period cap. They cost the holder nothing in tips. The two dust tests use conditional assertions; the fuzz test and the reviewer's exploit are the stronger evidence.

### 3. The seller could empty the reserve after listing (Low, fixed)

The reserve travels with the position, but the buyer's bounds did not cover it, so a seller could front-run `buy` with `withdrawReserveBtc` and keep the BTC.

**Fix:** `Bounds` gains `minReserveBtc` and `minReserveMusd`, checked against the vault in the same transaction as the payment.
**Regression tests:** `Market.t.sol::test_sellerCannotEmptyTheReserveAfterSigning`, `test_theMusdReserveIsPinnedToo`.
**Residual:** a pending collateral-surplus claim is not pinned. A buyer who cares should read it before buying.

## What the reviewer tried that did not work

Acting after a transfer (policy and listing both stamped with `transferEpoch`); seller action mid-`buy`; reentrancy through the NFT receiver hook, the tip call, the keeper, ERC-1271 wallets; signature replay and malleability; the fee cap and recipient; reserve accounting through `close`, `repay` and `adjust`; underflows in the planner; taking over the implementation or a clone; hostile hints; faking a low buffer to trigger the defense. The reviewer also reasoned (without a test) that filling 100 queue slots ahead of a vault could make the buffer verdict "unknown", and that this costs the attacker real collateral.

## Found later by the project's own checks (not by the reviewer)

These two were not in the AI-assisted review. They came from tests and a real browser run after it, and neither touches the contracts: the contracts' own answers were the reference in the first, and the second is in the app.

### The what-if simulator disagreed with the contract's planner in 81 of 503 states (fixed)

The app's what-if simulator runs a TypeScript port of the vault's `_plan` on a position that does not exist yet. `test/v2/PlannerVectors.t.sol` builds 503 random guardian states on the local MUSD deployment (a position, a redemption queue ahead of it, a reserve, a policy, a spent allowance and window, a price move, elapsed time), asks the vault's own `preview()`, and writes state and answer to `web/src/lib/__fixtures__/planner-vectors.json`. The web tests replay every vector against the port.

The first replay, against the port as first written, differed on **81 of 503**:

- **60 in Recovery Mode.** The contract needs an action to lift the trove to the system ratio when that is above 110% (finding 1 above). The port hard-coded 110% and so offered actions the contract would refuse.
- **21 in redemption defense.** When the policy's queue walk is shorter than the buffer reading the app has, the contract cannot see the buffer fall under the floor in time and says Unknown, which never acts. The port said Healthy.

Every other vector matched exactly: amounts, tips, ratios and the window reset.

**Fix** (`ceac938`): the minimum ratio is now an input, and the redemption verdict is worked out the way the contract does it (`verdictFrom`). With the contract's own verdict supplied, all 503 match. Derived from a buffer reading alone, 1 of 503 still differs, in the one case that cannot be known from the reading (the policy's walk is shorter than the reading and the reading is above the floor); there the simulator assumes the cautious Unknown, says so on screen, and a test checks it only ever errs towards holding. CI fails if the committed vectors are stale.
**Residual:** the app cannot know the system ratio at a price that has not happened, so in Recovery Mode the simulator keeps a warning instead of a number. The vectors come from a local deployment, not a fork of testnet, and do not reach the price-feed-down case.

### The redemption buffer check asked the original lens about a v2 position (fixed)

The position card's buffer check, and the simulator's copy of it, called the original `PositionLens` (the one deployed with the first set of contracts, the "Wave 1 lens") for every position. A v2 position's token id belongs to a different NFT contract and needs the v2 lens. The original lens answers for its own NFT, so the check either failed or answered for a different position with the same id. It never worked for v2 positions.

It was found by driving the real app with the test wallet against the live proof position (v2 NFT 1): the simulator's redemption slider, which is enabled by that check, never enabled. No unit test could have caught it, because components are not unit tested.

**Fix** (`ba76aa8`): both read the lens of the position's own wave (`web/src/lib/lens.ts`). **Regression test:** `web/src/lib/lens.test.ts`, which fails if either component goes back to a hardcoded lens. The run after the fix is recorded in `docs/features-e2e.json`.
**Residual:** this is a read-only display bug. No funds, permissions or contract behaviour were involved.

## What this review does not cover

- Mezo's own contracts, which are upgradeable proxies (see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).
- Economic review: whether the fee, the tip or the default caps are sensible.
- The web app and the keeper script, except for the two findings above that the project's own checks made later.
- A second pass after the fixes. The fixes were checked by their regression tests and by re-running the reviewer's exploits, not by a fresh review.
- One reviewer with one prompt will miss things.

## Other things found while building the tests

- The Wave 1 state-machine fuzz never moved the oracle price: its `movePrice` action reverted on every call because the handler did not own the mock aggregator. Fixed in both handlers; the Wave 1 invariants still hold with real price movement. Wave 1 contracts were not affected.
- Mezo reverts any adjustment that leaves a trove under 110% in normal mode. An early version of the planner offered such actions; the v2 fuzz caught it, and the planner now refuses them (decision 33).
