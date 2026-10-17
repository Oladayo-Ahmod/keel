# Test plan

Status at the first test pass: 77 tests, all passing, `forge test`. Coverage from `forge coverage --ir-minimum`:

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
| Fuzz | `VaultFuzz.t.sol` | open/close round trip with interest, Lens ICR against Mezo, refinance rule, non-holder access, nothing idle after any operation sequence |

## Next, before the testnet deploy

1. **Rolling outflow invariant.** Across any sequence of handler actions, the BTC that left the vault to holders plus the collateral still in the trove plus claimable surplus never exceeds what went in (opens, top-ups, redistribution gains). Tracked by a ghost variable in the handler.
2. **State-machine fuzz.** A handler that interleaves open, top-up, borrow, repay, refinance, close, redemption by a third party, price moves with liquidation, global rate changes, time warps and NFT transfers between several holders. After each step: the vault holds no idle funds; only the current holder succeeds on holder functions; the Lens agrees with Mezo; a stale holder or operator never succeeds.
3. **Invariants** on the same handler: permissions cleared on transfer (I3), payouts only to the caller (I4), vault never holds funds between calls (I2).
4. **matsnet fork layer**, small, pinned to one block: open, adjust, refinance, close and the Lens against the live proxies. Includes the proxy implementation slot check and a stale-hint check for `SortedTroves`.

## Wave 2

Marketplace settlement atomicity and value conservation across a sale (I5), bound checks, zombie positions (T20), cancellation (T22), rounding directions (T6), and guardian caps (T3), epoch invalidation (T2).
