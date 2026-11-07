# Test plan

Status (counted 2026-11-07, reconciled): **`forge test` reports 260 passing, 0 failed, 0 skipped** across 23 suites. **Web 299 tests** in 23 files (`npm test` in `web/`). **Keeper 24** (`npm test` in `keeper/`). **SDK 90** passing plus 39 read-only matsnet tests that are skipped unless run with `npm run test:matsnet -w @trozu/sdk` (11 files, one of them that skipped file). **MCP 78** (6 files). **Alerts 45** passing plus 1 opt-in live webhook test that is skipped (4 files). `npm test` in `packages/` runs the last three. They are separate suites and are not added together here.

Why the older numbers differed: **90 and 84 were the same Wave 1 suite counted two ways.** 90 is 83 unit and fuzz tests plus 7 invariants, counted one by one. 84 is what `forge test` prints for it: 83 plus one result, because forge folds each suite's invariants into a single result. Wave 2 then added the market, the guardian, the v2 invariants and a mechanical re-run of the Wave 1 vault tests against the v2 vault (`test/v2/regression/`). Counted one by one the source has 276 test and invariant functions, 18 of them invariants (7 in Wave 1's suite, 11 in Wave 2's); counted as forge reports them it is 260. This document uses the forge number, 260, and says so wherever it quotes it.

| Foundry suite group | Tests as forge reports them |
|---|---|
| Wave 1 (`test/unit`, `test/fuzz`, `test/invariant`) | 84 |
| Wave 2 market and guardian (`test/v2/Market`, `Guardian`) | 88 |
| Wave 2 deploy and invariants (`test/v2/DeployV2`, `invariant`) | 5 |
| Wave 1 vault tests re-run against the v2 vault (`test/v2/regression`) | 75 |
| Fork tests on mainnet state (`test/fork`) | 7 |
| Golden planner vectors (`test/v2/PlannerVectors`): one test that builds 503 states, writes them for the web tests and fails if a guardian branch is never reached | 1 |
| **Total** | **260** |

Packages: `packages/sdk/test` (maths, gas table against the web table and the round trip, errors, builders, lens, guardian and market reads on a mock chain, generated files against the ABIs), `packages/mcp/test` (tool schemas, hostile chain data and arguments, a check that the source cannot sign or send, a stdio handshake) and `packages/alerts/test` (rules, state and cooldown, webhook posting against a stubbed fetch). The SDK's matsnet tests simulate every builder with `eth_call` only (docs/INTEGRATIONS.md has the results). Web tests by file are in `web/src/lib/*.test.ts` (gas limits, market and guardian maths, permits, vault calls, error text, content files). The wallet round trip in [ROUNDTRIP.md](ROUNDTRIP.md) is a live run, not a test in these counts.

Coverage from `forge coverage --ir-minimum` (Wave 1, taken before Wave 2):

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| PositionFactory | 100% | 100% | n/a | 100% |
| PositionLens | 100% | 100% | 100% | 100% |
| PositionNFT | 100% | 100% | 100% | 100% |
| PositionVault | 98.4% | 96.5% | 81.8% | 100% |
| Total | 99.1% | 98.0% | 88.6% | 100% |

`--ir-minimum` is used because the default coverage build disables the optimizer. Branch figures are approximate for that reason.

All tests run on a local deployment of the real MUSD contracts (see ARCHITECTURE, Test layers). Threat IDs refer to THREAT_MODEL.md.

## Done

| Area | File | Covers |
|---|---|---|
| Fixture | `Fixture.t.sol` | the local deployment matches live parameters |
| Vault | `PositionVault.t.sol` | every function and revert path, access control, transfer resets, allowance isolation (T9), forced sends (T16), initialisation (T8) |
| Factory and NFT | `PositionFactory.t.sol` | ids, events, rejection paths, epoch, clone size, receiver rejection |
| Reentrancy | `Reentrancy.t.sol` | hostile contract holder against the real pools on withdraw, close, claim and sweep; NFT moved from inside the payout; factory re-entry and a finished position visible from the receiver hook (T4, T18) |
| Mezo-side events | `MezoEvents.t.sol` | full and partial redemption with surplus claim and reopen, liquidation and reopen, redistribution visible in the Lens, Recovery Mode and last-trove blocks (T10, T19) |
| Lens | `PositionLens.t.sol` | field accuracy against Mezo, interest accrual, rate spread, fee estimate, buffer exactness against a real redemption, capped and complete walks, verdicts, skipped liquidatable troves, inactive position, oracle failure (T11, T12, T13) |
| Permit | `Permit.t.sol` | permit, front-run permit, bad signature, new-holder isolation (T21) |
| Invariants and state machine | `test/invariant/` | see below |
| Fuzz | `VaultFuzz.t.sol` | open/close round trip with interest, Lens ICR against Mezo, refinance rule, non-holder access, nothing idle after any operation sequence |

## Invariants and state machine

`KeelHandler` interleaves open, top-up, withdraw, borrow, repay, adjust, refinance, close, reopen, surplus claim, approvals, NFT transfers, calls by strangers and previous holders, third-party redemption, price moves with liquidation, global rate changes and time warps over up to six positions and four actors. It keeps a ledger `L = collateral + claimable surplus` per vault. Seven invariants run after every step:

| Invariant | Meaning |
|---|---|
| `rollingOutflowWithinCollateral` | BTC paid to holders never exceeds BTC put in plus redistribution gains, summed over the whole run |
| `ledgerMovesOnlyByHolderFlows` | a holder action moves only its own vault's `L`, by exactly in minus out; every other vault is unchanged. This is the per-action form of "outflow never exceeds collateral plus surplus" |
| `externalEventsRespectTheLedger` | redemption never raises any `L`; liquidation never lowers another vault's `L`; price, rate and time change none |
| `onlyCurrentHolderMovesFunds` | no previous holder, operator or stranger ever succeeds on a holder function |
| `permissionsClearedOnTransfer` | the NFT owner always matches the expected holder, and the single-token approval is cleared by every transfer |
| `vaultsHoldNothing` | no vault keeps BTC or MUSD between calls |
| `lensAgreesWithMezo` | Lens collateral, debt, ICR and holder equal Mezo's own values after any history |

Runs: 64 runs of depth 64 by default. The `deep` profile runs 256 of depth 200 (51,200 calls per invariant) and passed. Mutation check: three deliberate bugs in the vault (anyone passes the holder check for one function, one wei less forwarded, the approved address passes the holder check) were each caught by at least one invariant, and the source was restored.

Limits of the suite, stated plainly:
- Holders are EOAs. Contract holders are covered by the unit tests in `Reentrancy.t.sol`, not by the state machine.
- A partial redemption needs exact list hints, so the handler mostly produces full or cancelled redemptions.
- The price range is 30,000 to 90,000 and Recovery Mode is reachable only when the random positions line up. Recovery Mode has its own unit test.
- The cumulative outflow bound is loose by design. The ledger equality is the strict check.

## matsnet checks

A forge fork test was not usable: the public RPC drops a few percent of connections and a fork run makes thousands of requests, so runs did not finish. The live-chain checks that matter are done as read-only RPC calls with scripts that retry:

| Check | Script | Result |
|---|---|---|
| redemption buffer walk cost | `script/measure/BufferWalker.sol` | VERIFICATION, gas of the buffer walk |
| stale hints in SortedTroves | `script/measure/hints.sh` | VERIFICATION, stale hints |
| proxy implementation slots and admins | `script/measure/proxy_slots.sh` | VERIFICATION, proxy slots |
| deploy dry run | `forge script script/Deploy.s.sol --fork-url ...` | 6.9M gas, succeeds |

Not done:
- a forge fork test of open, adjust, refinance and close against the live proxies. It would need a warm RPC cache or a more reliable endpoint. The first real exercise of the vault on the live contracts is the testnet demo.
- a bytecode comparison between the live implementations and the pinned source.

## Web app

`npm test` in `web/`: 299 tests, all passing (the first 42 came with Wave 1). They cover amount and ICR formatting, risk levels, the gauge range, sorted-list hint computation (call order, nothing cached, the NICR value measured on matsnet), the open plan checks (ICR floor, minimum net debt, gas reserve, missing price, collateral never under the target), error mapping, the transfer receiver and risk checks, the stale node assessment (lag behind the newest block, old head, retry until fresh, flag after the last attempt, rethrow after repeated failures) and the rule that stale data never reads as healthy. Since then: gas limits (tied to `docs/gas-measurements.json`), market and guardian maths, permits, vault calls, content files, the stats tally and snapshot, the fair-price estimate, share cards, the site URL check, team wallets, demo labels, the bundled font, the RPC transport, and the what-if planner port replayed against 503 golden vectors the contract produced (`web/src/lib/__fixtures__/planner-vectors.json`).

Not covered by automated tests: the components themselves and the wallet round trip. What was checked by hand:
- stale RPC in a real browser: `web/scripts/stale-check.mjs` fakes an old head block. With every answer old, the app shows the warning, a "Stale data" chip, the header pill warns, and nothing says Healthy. With three old answers then real ones, the app retries by itself and ends up showing the real ratio;
- layout at 390 and 360 px with a real mobile viewport, on the home page, a live position, and a fixture page that shows the cards in each state, the open form with a plan, every transfer step and the underwater warning. No horizontal overflow in any of the 16 checks (`web/scripts/measure-overflow.mjs`);
- the live position view against matsnet in desktop Chrome;
- the transfer contract path live on matsnet (see DEPLOYMENTS.md), not through the UI. A browser wallet cannot be driven from the environment these were built in, so the wallet prompt, the pending state and the success animation have not been seen end to end.

## Wave 2

Marketplace settlement atomicity and value conservation across a sale (I5), bound checks, zombie positions (T20), cancellation (T22), rounding directions (T6), and guardian caps (T3), epoch invalidation (T2).
