# Threat model

Scope: the wave 1 contracts (`PositionFactory`, `PositionVault`, `PositionNFT`, `PositionLens`) and, where marked **W2**, the wave 2 marketplace and guardian. Design is in [ARCHITECTURE.md](ARCHITECTURE.md). Mezo facts are cited in [VERIFICATION.md](VERIFICATION.md).

## Assets and actors

Assets: BTC collateral in the trove, MUSD debt and the locked interest rate, MUSD and BTC in flight inside a vault call, the NFT.

Actors: holder (owns the NFT), seller and buyer (**W2**), keeper (**W2**, anyone), redeemer, liquidator, MUSD governance, an attacker contract.

Trust assumptions: Mezo core contracts behave as documented and are not malicious, but they are upgradeable (see T14). OpenZeppelin is correct. The holder is trusted with their own position and nothing else.

## Invariants the design must keep

- I1. Only the current `ownerOf(tokenId)` can move funds out of a vault or change its trove.
- I2. A vault holds no funds between calls, other than forced sends.
- I3. After any NFT transfer, the previous holder, and anyone they approved, has no power over the vault.
- I4. Every external payout from a vault goes to the caller who is the holder.
- I5. (**W2**) A sale settles atomically, and the buyer receives at least what they committed to.

## Threats

Format: threat, how it works, mitigation, residual risk, tests. IDs are referenced from tests.

### T1. Bait and switch between listing and sale (**W2**)

A seller lists a healthy position, then drains collateral, borrows more MUSD or refinances before a buyer settles.
Mitigation: the buyer's order commits to bounds (`minColl`, `maxDebt`, `minRateDropBps` or a rate range, `maxLockedRate`, `epoch`). Settlement reads `getEntireDebtAndColl` in the same transaction and reverts if any bound fails. The listing also stores `transferEpoch`; a transfer voids it. Collateral can still be withdrawn between listing and sale, but then the bounds fail and the sale reverts instead of delivering a worse position.
Residual: a seller can grief by making sales revert. Cost to them is gas only. Listings expire.
Wave 1 note: none of this exists in wave 1. Wave 1 vaults give the holder full control, which is why a direct NFT sale in wave 1 is trust-based.

### T2. NFT transfer while a keeper action is pending (**W2**)

A keeper submits `execute()` built for holder A's policy. A transfers the NFT to B in the same block. Without protection, B inherits A's policy.
Mitigation: policies are stored with `transferEpoch`. `execute()` reads the epoch from the NFT and reverts on mismatch. The vault v2 guardian slot has the same epoch check. A new holder starts with no policy.
Residual: none expected. Test: transfer then `execute` must revert.

### T3. Keeper griefing or draining through policy edges (**W2**)

Attacker calls `execute()` repeatedly to burn the holder's reserve in fees, or crafts a state where a top-up is allowed but useless (for example ICR just above the floor but repeatedly crossing it).
Mitigation: every guardian action has a hard per-action and per-period cap, enforced on chain. Refinance requires the strict rate improvement and `maxFee`. Top-up cannot exceed the reserve and is rate limited. Keeper tip, if any, is bounded by the policy and paid only on success.
Residual: bounded loss equal to the configured caps. Fuzz target: sum of guardian outflows per period never exceeds the policy.

### T4. Reentrancy through native BTC callbacks

Mezo sends BTC with `recipient.call{value:}("")` from ActivePool and CollSurplusPool, and its own comment says re-entry is fine (`SendCollateral.sol:11`). The vault is the recipient on withdraw, close and claim. It also forwards BTC to the holder, which can be a contract.
Mitigation: `nonReentrant` on every state-changing vault function. `receive()` accepts BTC only from ActivePool and CollSurplusPool and does nothing else, so a callback into the vault has no state to corrupt. Payout to the holder happens last, after all Mezo calls. Funds are forwarded by balance delta.
Residual: a holder contract that rejects BTC makes its own `close` revert. That harms only that holder. An attacker cannot trigger it, because the payout always goes to the caller.
Tests: a malicious holder that re-enters `close`, `withdrawCollateral` and `repay` from its `receive`. Reentrancy from the Mezo callback path using a mock ActivePool that calls back.

### T5. Redistribution changes state during settlement (**W2**, and Lens reads in W1)

Between listing and settlement a liquidation redistributes debt and collateral. The stored trove is stale until touched.
Mitigation: all reads use `getEntireDebtAndColl`, which includes pending redistribution and accrued interest (VERIFICATION section 5). Settlement reads in the settling transaction. In wave 1 the Lens documents that figures are point-in-time.
Residual: a redistribution can land in the same block before settlement. The bounds make that revert, not misprice.
Test: fork test with a redistribution between the bound check inputs and settlement.

### T6. Rounding in rate-premium pricing (**W2**)

The price of a below-market rate position is derived from `principal * rateSpread / 10_000` over a horizon. Rounding can be exploited by splitting positions or by choosing parameters that round in the attacker's favour.
Mitigation: all pricing rounds against the party that sets the price (floor for amounts the seller receives, ceil for amounts the buyer pays), one rounding step per formula, `mulDiv` from OpenZeppelin, no division before multiplication. Wave 1 Lens rounds the annual spread toward zero and labels it informational.
Residual: dust-level differences, below the gas cost of exploiting them.
Fuzz target: price is monotone in spread, collateral and horizon, and a position split into two cannot sell for more than the whole.

### T7. Owner front-runs a refinance

A third party sees a refinance and front-runs. Or the holder is surprised by a rate that changed.
Facts: refinance is callable only by the borrower (the vault). Global rate changes need a governance proposal and a 7 day delay (`InterestRateManager.sol:28,129-152`). The refinance sets the trove to the current global rate, higher or lower, with no slippage argument.
Mitigation: the vault wrapper requires `globalRate + max(minRateDropBps,1) <= lockedRate` and `feeActual <= maxFee`, and checks the new rate equals the global rate. A rate change cannot land inside the transaction. A 7 day public window precedes it.
Residual: a holder who refinances just before they would have sold at a premium loses the premium. That is the holder's decision. **W2:** a listing's committed `maxLockedRate` makes a front-run refinance (which lowers the locked rate) fail the buyer's bound only if the bound is a range. Use a range.

### T8. Vault clone initialisation attacks

Attacker initialises the implementation, or front-runs `initialize` on a fresh clone, to become the owner or to set a malicious token id.
Mitigation: the implementation's constructor locks initialisation. `initialize` is callable once and only by the factory, in the same transaction as the clone, so there is no window. The vault reads its authority from the NFT, not from a stored owner, so even a wrong `tokenId` would need the NFT to say the caller is the holder.
Residual: none expected. Tests: second `initialize`, `initialize` from a non-factory, and direct calls on the implementation all revert.

### T9. Approval and operator leakage across NFT transfers

The seller approved MUSD to the vault, approved a marketplace on the NFT, or set an operator, and keeps influence after selling.
Mitigation:
- Vault authority is `ownerOf` at call time. ERC-721 approvals and operators can move the NFT only, never funds. OpenZeppelin clears the per-token approval on transfer.
- The vault pulls MUSD from `msg.sender` only. The seller's MUSD allowance to the vault is useless to the new holder, because the new holder is the caller and uses their own allowance.
- Wave 2 permissions (listings, guardian) are keyed by `transferEpoch`.
Residual: `setApprovalForAll` operators the seller granted on their own wallet remain on their other tokens, as in any ERC-721. They do not apply to the buyer's token after transfer, because OpenZeppelin checks the current owner's operators.
Tests: after transfer, every holder-only function reverts for the old holder and for an address the old holder had approved.

### T10. Redemption of the position

A redeemer burns MUSD to take collateral from low-ICR troves first. The vault loses collateral at oracle price and may be closed (`TroveManager.sol:1252-1271`), leaving surplus in CollSurplusPool.
Mitigation: this is protocol behaviour, not an attack. KEEL reports the redemption buffer and surplus so the holder can act, and `claimSurplus` recovers the surplus. The vault can reopen after the trove closes.
Residual: the buffer is a lower bound and moves (see below). The UI does not call it safe.

### T11. Misuse of the redemption buffer

A trigger or UI treats a capped walk as proof that the buffer is small, or treats a stale buffer as a guarantee.
Mitigation: `complete` and `Verdict` semantics in the Lens. Only a complete walk proves a small buffer. Skipped liquidatable troves can exhaust the step cap and give `Unknown`. Any on-chain consumer must act only on `complete == true` or `Below`.
Test: a fork test with a capped walk that cannot return `Below`.

### T12. Lens or vault gas exhaustion

An attacker fills the tail of SortedTroves with minimum-size, liquidatable or redeemable troves so the walk costs more than a block's worth.
Mitigation: the walk takes a `maxSteps`. Measured cost per step is in VERIFICATION. The UI and any keeper choose the cap. The vault's state-changing functions do not walk the list. The hints they pass come from the caller.
Residual: the Lens view can return `Unknown` for a deep position. That is a degraded display, not a loss of funds.

### T13. Oracle and price manipulation

`PriceFeed.fetchPrice` reads a chain precompile (found in phase 0). A wrong price changes ICR in the Lens and in Mezo's own checks.
Mitigation: KEEL has no price-dependent state change of its own in wave 1; Mezo enforces MCR and CCR on every borrow and withdrawal. **W2** guardian actions and settlement checks re-read the price in the transaction and reject a zero or reverting price.
Residual: oracle failure is a protocol risk that KEEL inherits.

### T14. Upgradeable Mezo core contracts

All core contracts are proxies (`initialize`, storage gaps; VERIFICATION section 8). Governance or an admin can change their code. A change could alter fees, remove a getter KEEL relies on, add an EOA check, change the redemption order, or block a function. The sorted list and the trove struct are also read by KEEL.
Impact: loss of function, mispriced Lens figures, or in the worst case a hostile upgrade that locks vaults. KEEL cannot prevent this, because it holds no admin power over Mezo.
Mitigation: KEEL's contracts are immutable and hold no assets beyond what Mezo already holds for the trove; there is no KEEL-side pause or upgrade path to compromise. Core addresses are immutables in the implementation, so a KEEL deploy is bound to one Mezo deployment. Fork tests run against the live proxies and are re-run before every release, so a behavioural change shows up. The Lens reads through interfaces and treats a reverting getter as "unknown", not as zero.
Residual: accepted and stated in `KNOWN_LIMITATIONS.md`. Do not describe positions as trustless with respect to Mezo governance.

### T15. NFT-level attacks

- Phishing: a user signs a `setApprovalForAll` for a malicious operator and loses the position. Standard ERC-721 risk. UI shows approvals and warns.
- Stuck transfer to a contract that cannot handle the position: `safeTransferFrom` checks the receiver; a plain `transferFrom` does not. The UI uses `safeTransferFrom`. The vault accepts holders that are contracts.
- Gifting an underwater position: the receiver gets debt that cannot be repaid by collateral. The Lens shows ICR and equity before transfer. There is no on-chain block on this, deliberately: positions are assets.

### T16. Forced BTC or token sends to a vault

`selfdestruct` or coinbase sends can put BTC in a vault. Anyone can send ERC-20s.
Mitigation: `sweep` returns them to the holder. Invariant I2 allows forced sends explicitly. Forwarding uses balance deltas so a forced balance never mixes with an operation's payout.

### T17. Fee exemption and governance parameters

Governance can make accounts fee exempt, change `borrowingRate`, `refinancingFeePercentage`, `minNetDebt` and the global rate, each behind a delay (VERIFICATION sections 3, 4).
Mitigation: vault entry points that spend a fee take `maxFee`. The Lens reads parameters live.
Residual: parameters can move between a UI quote and execution; `maxFee` bounds the loss.

### T18. Factory mint callback

`PositionFactory.openPosition` mints with `_safeMint`, which calls `onERC721Received` on a contract receiver. A hostile receiver could re-enter the factory in the middle of position creation.
Mitigation: `openPosition` is `nonReentrant`, and the mint is the **last** step. By then the clone is initialised and the trove is open, so the callback sees finished state. The first `open` runs through a factory-only entrypoint on the vault that does not read `ownerOf`, since the token does not exist yet (see ARCHITECTURE).
Residual: a receiver that reverts in `onERC721Received` makes its own `openPosition` revert, which cancels the whole transaction, including the trove.
Test: a receiver contract that re-enters `openPosition` and the vault from `onERC721Received` must revert, and a normal contract receiver must succeed.

### T19. Recovery Mode lock-in and the last-trove block (liveness)

Mezo restricts positions when the system TCR falls below 150% (Recovery Mode). While it lasts: `refinance` reverts (`BorrowerOperations.sol:1023`), `closeTrove` reverts when BorrowerOperations can mint (`:954`), collateral withdrawal is refused and a debt increase must keep ICR at or above CCR and not lower ICR (`:1265-1275`). Separately, the last trove in the system cannot close (`TroveManager.sol:1488-1496`, `:1397-1399`).
Impact: a holder, or a buyer who just paid for a position, cannot exit or refinance for as long as the mode lasts. Nothing in KEEL can lift it.
Mitigation: none on chain, because this is protocol behaviour. The Lens exposes `recoveryMode` and `canClose`, and the UI shows them. Repaying debt and adding collateral stay allowed, and the wrappers add no extra restriction. **W2:** listings must not promise an exit, and the guardian skips refinance in Recovery Mode instead of reverting the whole call.
Residual: accepted. Described in `KNOWN_LIMITATIONS.md`.
Test: enter Recovery Mode locally, check each wrapper reverts with the Mezo reason, and check `repay` and `addCollateral` still work.

### T20. Zombie positions (**W2**)

After a redemption close, a liquidation or a `close`, the vault and its NFT still exist but the trove is gone. The NFT is worth only the claimable surplus, possibly zero. It can still be listed, and a buyer who checks only price and `ownerOf` buys an empty shell.
Mitigation: wave 2 order bounds must require `minColl > 0` and trove status `active`, both read from `getEntireDebtAndColl` and `TroveManager.getTroveStatus` in the settling transaction. An order with `minColl == 0` is rejected at creation and at settlement. The Lens reports `active`, and the UI hides inactive positions from the market view. Wave 1 has no market, so a zombie there is just an NFT the holder can reopen or claim surplus from.
Residual: a buyer who knowingly wants surplus-only positions has no path. None is planned.
Test: settle against a closed, a redeemed and a liquidated vault and expect a revert each time.

## Out of scope

Compromise of a holder's key. Mezo consensus failure. Bugs in OpenZeppelin. Economic attacks on MUSD's peg.
