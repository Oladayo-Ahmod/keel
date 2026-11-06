# Mezo integration scan (Wave 2, phase A3)

Read-only. Nothing here is built yet. Everything below was read from Mezo mainnet (chain 31612) over the public RPC on 2026-11-06, or from the `lib/musd` checkout, and the limits of each check are stated.

## 1. The MUSD savings vault as a guardian reserve

**Address.** The MUSD `PCV` contract's `feeRecipient()` on mainnet is `0xb4D498029af77680cD1eF828b967f010d06C51CC`. On chain it reports `name() = "MUSD Savings Rate"`, `symbol() = "sMUSD"`, 18 decimals, and its `musdToken()` is the mainnet MUSD at `0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186`. It is an EIP-1967 proxy (implementation `0xb33c3f97bf3b7df59417d114c694353e42929e87`).

**It is not ERC-4626.** I called `asset()`, `totalAssets()`, `convertToAssets`, `previewDeposit`, `previewRedeem`, `maxWithdraw`, `maxRedeem` and `maxDeposit` on it. Every one reverts with empty data. The selectors present in the implementation bytecode that I could match to signatures:

| Function | Notes |
|---|---|
| `deposit(uint256)` | MUSD in, sMUSD out |
| `withdraw(uint256)` | sMUSD amount in |
| `claimYield()`, `claimableYield(address)` | yield is claimed separately |
| `yieldIndex()`, `pendingYield()` | index based accounting |
| `receiveProtocolYield(uint256)` | called by PCV |
| `strategy()`, `setStrategy(address)`, `allocate(uint256)`, `deallocate(uint256)`, `receiveYieldFromStrategy()` | MUSD can be moved into a strategy contract |
| `migrate(address)`, `setPCV(address)`, `owner()`, `initialize(address)` | admin surface |
| `transfer`, `approve`, `balanceOf`, `totalSupply` | plain ERC-20 receipt token |

Six selectors in the bytecode did not resolve against the signature database (`10f3737f`, `23256f2c`, `3d564920`, `4957fbae`, `9791a164`, `d0e98283`), so this list is not complete. The rest are standard ERC-20 and ownership functions.

**Docs and chain disagree on mechanics.** Mezo's docs say yield "accumulates in the sMUSD exchange rate". The contract has a `yieldIndex` and a `claimYield()` function, so on this deployment it looks like an index plus separate claim, not a rising share price. I did not resolve which one is true in practice. A guardian reserve must not assume a share price.

**Instant withdraw: probably, with one thing I could not prove.** The docs list "Withdrawal fee: None, Withdrawal time-lock: 0h". As an `eth_call` simulation at the latest block, `withdraw(uint256)` from the largest recent sMUSD holder did not revert for 1 sMUSD, half the balance (39,340) or the full balance (78,680). The vault held only about 43,471 MUSD idle against 1,251,295 sMUSD supply, so the larger withdrawals would have had to pull funds back from the strategy, and they did not revert. Limits: a simulation returns no amount and I did not check what a holder actually receives, I tested one holder, and I cannot test the case where many holders exit at once.

**Risks that matter for a reserve.**
- Funds are deployed into a `strategy` (`0x0c0944713c185ea3e64f5609ecee3fb3c054a295`, a 2.3 KB contract). The owner can change it.
- The vault is upgradeable and governed (owner `0x98D8899c3030741925BE630C710A98B57F397C7a`, proxy admin `0x973c1a54b1b8d4ad04ea1d8469cda159672b95d0`).
- The docs call the withdraw instant, but a reserve that must pay a keeper inside one transaction depends on the strategy having liquidity at that moment.
- `claimableYield` for the holder I tested returned about 39,167 MUSD against a balance of 78,680 sMUSD. I did not read the implementation source, so I do not know what unit or period that number is in. Do not quote it.

**Recommendation.** Do not hold the guardian reserve in sMUSD in Wave 2. Keep the explicit reserve in the vault itself (plain BTC and MUSD, withdrawable by the holder at any time, as specced in B2). Offer sMUSD as an optional, clearly labelled idle-reserve parking spot only if there is time after the core guardian ships: deposit and withdraw by the holder, never touched by `execute()`. That keeps the keeper path free of a third-party liquidity dependency. Cost to add later: small, about two external calls and a balance mirror. Honest value to the pitch: a real Mezo-native yield option for the reserve, but it is a nice-to-have.

## 2. `InterestRateProposed` as a rate-watch feed

`InterestRateManager` (`0x4a453700d157717Fe02fB62E7700ED7845048285`) emits `InterestRateProposed(uint16 proposedRate, uint256 proposalTime)` when governance proposes a rate and `InterestRateUpdated(uint16 newInterestRate)` when it takes effect. `approveInterestRate()` requires `MIN_DELAY`, which is 604,800 seconds (7 days) on mainnet. So a proposal gives at least a week of warning before the global rate changes.

This is genuinely useful to a position holder, because a Mezo trove locks the global rate at open. If the proposed rate is lower than the rate you locked, refinancing after approval is worth checking; if higher, opening before approval locks the old rate. The state is readable without events too: `proposedInterestRate()` and `proposedInterestRateTime()` are public views, and today both equal the current rate (100 bps), so there is no live proposal. See `docs/MARKET_DATA.md` for the history.

Cost: a keeper or web alert that reads two views and subscribes to two events. About half a day including the banner in the app. The honest caveat is that on current evidence the rate has not moved, so the alert would be quiet most of the time. Build it only as a small banner on the refinance screen and in the keeper, not as a headline feature.

## 3. Other cheap, honest hooks

- **Redemption pressure from live data.** `TroveManager` emits `Redemption` and `TroveUpdated` (operation 2 is `redeemCollateral`). The redemption-defense logic in the guardian is already built around the sorted list, and this lets the app show real redemption history for the system. Cost: nearly free, the market-data script already reads it.
- **`SortedTroves` and `HintHelpers`.** Already used in Wave 1 for hints. No new hook.
- **Mezo Passport.** Already in the web app. Nothing to add.
- **sMUSD gauge and veBTC voting.** The docs describe a MUSD Savings gauge that competes for veBTC votes. That is the Mezo Earn side, not the CDP. Out of scope; adding it would be padding.
- **Not checked.** The Ditto MUSD Savings Vault listed in the docs, the USDC lending vault and the MUSD bridge. I did not read them, so I make no claim about them.
