# Test plan

Status: 90 tests, all passing, `forge test` (83 unit and fuzz tests, 7 invariants). Coverage from `forge coverage --ir-minimum`:

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

## Wave 2

Marketplace settlement atomicity and value conservation across a sale (I5), bound checks, zombie positions (T20), cancellation (T22), rounding directions (T6), and guardian caps (T3), epoch invalidation (T2).
