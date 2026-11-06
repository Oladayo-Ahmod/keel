# Phase 0 verification

Source read: `mezo-org/musd` at commit `aa25fd6` (main, 2026-09-23), `solidity/contracts/`. Paths below are relative to that directory unless stated. Docs read: mezo.org/docs/developers. Live checks were made with `cast` against `https://rpc.test.mezo.org` (chain id 31611, confirmed).

Status legend: **verified** = read in code or confirmed on chain; **partial** = read but not tested; **open** = not verified yet.

## Verdict

Contracts can own and manage troves. The product as specified is feasible with no change to the plan. Details that shape the design are marked **Design impact**.

## 1. Trove key and contract ownership (verified)

- A trove is keyed by the borrower address. Every user entrypoint passes `msg.sender` as the borrower: `BorrowerOperations.sol:185` (`openTrove`), `:193-196` (`addColl`), `:279` (`closeTrove`), `:286` (`refinance`), `:317` (`claimCollateral`).
- One trove per address: `_requireTroveisNotActive` (`BorrowerOperations.sol:1140-1148`) reverts only when status is `active`. After close, redemption close or liquidation the same address can open again. **Design impact:** one vault per position is required (an NFT cannot move a trove between addresses), and a vault can be reused after its trove closes.
- No `tx.origin` in any production contract. The only code-size check is `CheckContract` (`dependencies/CheckContract.sol:16`), used in the `setAddresses` style setters, not on user paths. No EOA gate on `openTrove`, `adjustTrove` or `closeTrove`.
- The adjust path asserts the caller is the borrower, the Stability Pool (collateral-only top up) or the signatures contract (`BorrowerOperations.sol:796-802`). A vault calling for itself passes.
- MUSD refuses transfers to the MUSD token address itself and to zero (`token/MUSD.sol:56-71`). Vaults are not affected.

## 2. How native BTC and MUSD move (verified)

| Action | BTC | MUSD |
|---|---|---|
| `openTrove` | `msg.value` becomes collateral (`BorrowerOperations.sol:651,680,715`) | minted to `msg.sender` (`_withdrawMUSD(..., _recipient, ...)`, `:716-722`) |
| `addColl` / `adjustTrove` with value | `msg.value` | none |
| `withdrawColl` | sent from ActivePool to `_recipient` by low-level call (`:925-936`, `dependencies/SendCollateral.sol:9-13`) | none |
| `withdrawMUSD` | none | minted to recipient |
| `repayMUSD` | none | burned from the caller (`_caller`), no allowance involved (`:855-861`, `_moveTokensAndCollateralfromAdjustment`) |
| `closeTrove` | `activePool.sendCollateral(_recipient, coll)` (`:1009`) | burned from caller: `debt - 200e18` (`:997`); the 200 MUSD gas reserve is burned from the GasPool (`:1000-1006`) |
| `claimCollateral` | `collSurplusPool.claimColl` sends to recipient (`CollSurplusPool.sol:87-102`) | none |

Facts the vault needs:

- `receive()` that accepts BTC from ActivePool and CollSurplusPool. Both use `recipient.call{value:}("")` and the code comment says `re-entry is fine here` (`SendCollateral.sol:11`). **That is a reentrancy surface in the middle of BorrowerOperations and TroveManager state changes.** The vault must guard with `nonReentrant` on every state-changing entrypoint and must not read trove state from inside `receive`.
- MUSD must already be in the vault before `repayMUSD` or `closeTrove`. The owner approves MUSD to the vault (MUSD is `ERC20Permit`) and the vault pulls it, or the owner sends it in the same transaction.
- `closeTrove` calls `_requireNewTCRisAboveCCR` and `_requireNotInRecoveryMode` when BorrowerOperations can mint (`:954-973`). Closing can be blocked in Recovery Mode. The last trove in the system cannot close (`TroveManager.sol:1488-1496`, `:1397-1399`).
- Redemption leaves surplus collateral in CollSurplusPool under the vault address (`TroveManager.sol:1175-1201`). It only comes out via `claimCollateral`. **Design impact:** the vault needs `claimSurplus()`, and the Lens needs to report claimable surplus.
- Other MUSD flows (SP deposits, savings) are out of scope.

## 3. `openTrove` signature (verified)

Deployed and source signature: `openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) payable` (`BorrowerOperations.sol:180-186`), selector `0x2f3a6d98`.

- `docs/README.md:748` still shows a Liquity v1 style `openTrove(maxFeePercentage, debtAmount, upperHint, lowerHint)`. That example is wrong. There is **no `maxFeePercentage` argument**. The borrowing fee is `debt * borrowingRate / 1e18` (`:510-512`, `:602-611`) and is minted to PCV. It is added to the trove's debt, not taken from the minted amount (`:641-643`).
- Fee exempt accounts skip it (`governableVariables.isAccountFeeExempt`, `:637-639`). Recovery Mode also skips it.
- Because there is no `maxFeePercentage`, the vault has to enforce its own bound. `borrowingRate` is governance controlled with a delay; the vault should read `getBorrowingFee` and let the caller pass `maxFee`.
- Live values on matsnet: `borrowingRate` = 1e15 (0.1%), `minNetDebt` = 1800e18, `redemptionRate` = 7.5e15 (0.75%), `refinancingFeePercentage` = 20. They match the constructor defaults at `BorrowerOperations.sol:143-152`.
- Fixed constants (`dependencies/LiquityBase.sol`): MCR 110%, CCR 150%, gas compensation 200e18.
- Hints are `(upperHint, lowerHint)` into SortedTroves, ordered by NICR. `HintHelpers.getApproxHint(_CR, _numTrials, _seed)` returns a start hint, then `SortedTroves.findInsertPosition` gives the pair (`HintHelpers.sol:184`, `SortedTroves.sol:193`). `HintHelpers.computeNominalCR` exists (`:235`). Hints are computed off-chain by the frontend or keeper and passed in. A stale or missing hint never reverts, it only costs gas; see [Stale hints](#stale-hints-in-sortedtroves).

## 4. Interest rate and refinance (verified)

- Global rate: `InterestRateManager.interestRate()` is `uint16` in basis points, max 10 000 (`InterestRateManager.sol:21,31`). Live matsnet value: 100 (1%).
- Per-trove rate: `TroveManager.getTroveInterestRate(borrower)` (`TroveManager.sol:601`). It is set to the global rate at open (`BorrowerOperations.sol:668-672`) and is **only changed by `refinance`** (`:1075`).
- Simple interest per trove: `principal * rate * dt / (10_000 * 31_556_952)` (`dependencies/InterestRateMath.sol:11-20`). Accrued interest is stored lazily and brought up to date on any touch (`TroveManager.sol:871-885`).
- Global rate changes need governance `proposeInterestRate` then `approveInterestRate` after `MIN_DELAY = 7 days` (`InterestRateManager.sol:28,129-152`). **Design impact:** a rate change is publicly visible for at least 7 days. A seller or owner cannot be surprised by one inside a transaction. A refinance front-run window against a listing exists only inside that known 7 day notice. Keepers can key on the `InterestRateProposed` event.
- Refinance (`BorrowerOperations.sol:1012-1105`):
  - Sets the trove rate to the **current global rate, whether that is lower or higher**. There is no `minRateImprovement` or slippage argument. **Design impact:** the guardian must check `globalRate < lockedRate - X` before calling. The vault should enforce it again inside its own `refinance()` wrapper with an `expectedGlobalRate` check.
  - Reverts in Recovery Mode (`:1023`) and if the new ICR is below MCR or TCR below CCR (`:1058-1059`).
  - Fee: `amount = refinancingFeePercentage * netDebt / 100`, then the borrowing fee is applied to that amount (`:1032-1035`), so fee = `netDebt * 20/100 * 0.1%` = **0.02% of net debt** with live values. It is added to the trove's debt (`increaseTroveDebt`, `:1037`) and minted to PCV, not paid in tokens. Fee exempt accounts pay 0. Note `netDebt` here is `_getNetDebt(getTroveDebt)`, which includes accrued interest.
  - Needs sorted list hints (`:1088`). The new NICR uses `newPrincipal` (see section 6).
- Interest from all troves is minted to PCV through `updateSystemInterest` (`InterestRateManager.sol:163-185`).

## 5. `getEntireDebtAndColl` and pending redistribution (verified)

`TroveManager.getEntireDebtAndColl(borrower)` (`:767-802`) returns `(coll, principal, interest, pendingColl, pendingPrincipal, pendingInterest)` where the first three already include the pending parts and accrued-since-last-update interest.

- `interest = stored interestOwed + accrued since lastInterestUpdateTime + pendingInterest`.
- `pendingColl = stake * (L_Collateral - snapshot) / 1e18` (`:804-820`). Debt works the same way (`:822-847`). These are credited by redistribution after a liquidation that exceeds the Stability Pool, and are **applied to the stored trove only when the trove is touched** (`_updateTroveInterest` calls `_applyPendingRewards`, `:871-885`).
- `getTroveDebt` and `getTroveColl` do **not** include pending redistribution (`:591,619`, `_getTotalDebt` at `:1513-1527` has no pending part). `getCurrentICR` does include it (`:736-750`, `_getCurrentTroveAmounts` at `:1498-1511`).
- **Design impact:** the Lens and the marketplace settlement must read `getEntireDebtAndColl` (or `getCurrentICR`), never `getTroveColl` and `getTroveDebt`. Values drift every second from interest and every liquidation from redistribution, so listing commitments must be bounds (`minColl`, `maxDebt`, `rate` check) evaluated in the settlement transaction, not exact values.
- Gotcha: the sorted list key is NICR from stored principal and stake (see section 6), not ICR. It is not updated by interest or by redistribution until the trove is touched.

## 6. Redemption order and the redemption buffer (verified, gas open)

- `redeemCollateral` starts at `sortedTroves.getLast()` (smallest NICR) and walks `getPrev`, skipping troves whose current ICR is below MCR (`TroveManager.sol:330-350, 360-405`). A valid `_firstRedemptionHint` shortcuts the start (`:1452-1468`).
- Order key is **NICR = coll * 1e20 / principal** (`getNominalICR` `:566-577`, `LiquityMath._computeNominalCR`). It does not depend on price and ignores interest. A trove below MCR is skipped but stays in the list.
- Each redeemed trove gives up `min(remaining, totalDebt - 200e18)` of debt, in collateral at oracle price (`:1218-1230`). It is closed if only the 200 gas reserve is left (`:1252-1271`), otherwise partially redeemed and reinserted (`:1272-1331`). A partial redemption is cancelled if the remaining net debt would fall below `minNetDebt` (`:1302`).
- Redemption fee 0.75% in collateral, sent to PCV (`:411-437`). Redemption only works while TCR >= 110% (`:1470-1475`).
- **Redemption buffer for trove T** = sum over troves from `getLast()` up to but excluding T, of `(totalDebt - 200e18)` for troves with ICR >= MCR. That is the MUSD that has to be redeemed before T is touched. Walk: `getLast` then `getPrev` until T. Per step: `getCurrentICR` plus `getEntireDebtAndColl`, several external calls.
- Properties for the Lens:
  - It is a **lower bound that moves**: troves ahead of T can top up, close or be redeemed, and T's own NICR changes when T is adjusted.
  - Sort order can lag true ICR. Two troves with equal NICR but different rates have different debt growth. Treat the figure as an estimate, not a guarantee.
  - Bounded iteration: `bufferOf(T, maxSteps)` returns `(buffer, complete)`. If `complete` is false the buffer is at least the returned value. A trigger of the form "buffer below X" can only be trusted when `complete` is true; a partial walk can prove the buffer is large but never that it is small.
  - Gas is measured, see [Gas of the buffer walk](#gas-of-the-buffer-walk). About 24.7k gas per trove, so a full walk of today's 281 troves is about 7M gas. Mainnet size is not checked.
- `HintHelpers.getRedemptionHints` already has the same walk with `_maxIterations` (`HintHelpers.sol:79-170`). It is a reference for loop shape, not reusable as is (it simulates a given amount).

## Gas of the buffer walk

Measured 2026-10-21 against live matsnet state, using `script/measure/BufferWalker.sol`. Its constructor performs the walk and the node executes it server side with `cast estimate --create` and `cast call --create`. A local fork was tried first and dropped: forge makes thousands of sequential state requests and a run did not finish in 45 minutes against the public RPC.

The walk is the single-call variant planned for the Lens: `getLast`, then per trove `getEntireDebtAndColl` plus `getPrev`, ICR computed locally. The price is a fixed argument (84 127.77 USD) because the oracle is a precompile.

| Cap (steps) | Gas (estimate, includes about 130k create overhead) |
|---|---|
| 10 | 376,623 |
| 50 | 1,363,468 |
| 100 | 2,597,471 |
| 1000 (walks all 281) | 7,068,514 |

- **About 24.7k gas per trove** (slope between caps 10, 50 and 100 is 24.7k each). A full walk of 281 troves is about 6.9M gas plus the overhead.
- The `estimate` figure is the minimum gas at which the call succeeds, so it includes the cold storage reads a real `eth_call` pays.
- Live state at the measured block: 281 troves, all with ICR at or above 110%, smallest eligible lot 1,801.08 MUSD (the minimum is the live `minNetDebt` of 1800, so "about 1600" in the planning note is conservative), total debt ahead of the last trove 429,012,801 MUSD. One very large trove dominates the total.
- Implication: a cap of 100 steps costs about 2.6M gas, which is the default I will use for the Lens. Any on-chain trigger that must prove a buffer is small needs a complete walk, so at today's size it is a keeper-side check, not something to run inside another transaction.
- Not measured: the node's `eth_call` gas cap and the block gas limit. If a call at cap 1000 had failed I would have lowered the cap. It succeeded at about 7.07M.

## 7. `BorrowerOperationsSignatures` (verified)

- EIP-712 domain: name `"BorrowerOperationsSignatures"`, version `"1"` (`:93-94`), `OZ EIP712Upgradeable`, verifying contract is the signatures contract itself.
- Types exist for open, add coll, withdraw coll, repay, withdraw MUSD, adjust, close, refinance, claim collateral (`:96-139`). Each struct contains `borrower`, `nonce`, `deadline` plus `recipient` where funds move.
- Nonce: one counter per borrower, `mapping(address => uint256) nonces` (`:141`), read via `getNonce` (`:600`), incremented on every successful signature (`:626`). There is **no cancel or invalidate function** (only three references to `nonces[` in the file). The only expiry is the `deadline` (`:612`).
- Signature check is plain `ECDSA.recover` against the borrower (`:620`). **No ERC-1271.** A vault contract cannot sign, so it cannot be the borrower of a signed action.
- Relayed calls pass `msg.sender` as `_caller`, so repay and close take MUSD from the relayer, not from the borrower (for example `:291-300`). `recipient` may not be a core pool (`:160-177`).
- **Design impact:** the keeper design cannot rely on this contract, because the borrower is the vault. The guardian therefore goes through the vault's own on-chain policy checks, not signatures. The contract is only useful for the fallback in the brief (an EOA-keyed trove with signed delegation), which is not needed.

## 8. matsnet addresses and faucet (verified, with one open item)

Network: Mezo Testnet (matsnet), chain id 31611, RPC `https://rpc.test.mezo.org`, WSS `wss://rpc-ws.test.mezo.org`, explorer `https://explorer.test.mezo.org`, explorer API `https://api.explorer.test.mezo.org/api` (`solidity/hardhat.config.ts:103-107,214-225`; docs "Set Up Developer Environment"). Mainnet is chain id 31612.

| Contract | Address |
|---|---|
| ActivePool | 0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51 |
| BorrowerOperations | 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5 |
| BorrowerOperationsSignatures | 0xD757e3646AF370b15f32EB557F0F8380Df7D639e |
| CollSurplusPool | 0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9 |
| DefaultPool | 0x59851D252090283f9367c159f0C9036e75483300 |
| GasPool | 0x8fa3EF45137C3AFF337e42f98023C1D7dd3666C0 |
| GovernableVariables | 0x6552059B6eFc6aA4AE3ea45f28ED4D92acE020cD |
| HintHelpers | 0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6 |
| InterestRateManager | 0xD4D6c36A592A2c5e86035A6bca1d57747a567f37 |
| MUSD | 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 |
| PCV | 0x4dDD70f4C603b6089c07875Be02fEdFD626b80Af |
| PriceFeed | 0x86bCF0841622a5dAC14A313a15f96A95421b9366 |
| SortedTroves | 0x722E4D24FD6Ff8b0AC679450F3D91294607268fA |
| StabilityPool | 0x1CCA7E410eE41739792eA0A24e00349Dd247680e |
| TroveManager | 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0 |

Sources: `docs/CHANGELOG.md` "Matsnet Addresses" table and `solidity/artifacts/deployments/matsnet/*.json`. The two agree for all 15. Live check: all return code, and `interestRate` (100), `borrowingRate`, `refinancingFeePercentage`, `minNetDebt`, `redemptionRate` match the source defaults. Testnet state seen: 280 troves, oracle price 84 127.77 USD per BTC, lowest trove ICR about 113.9%.

- Faucet for testnet BTC: `https://faucet.test.mezo.org/` (docs FAQ). **MUSD has no faucet I found.** Test MUSD comes from opening a trove (min net debt 1800 MUSD, so roughly 3.1k USD of BTC at 110%+ ICR, in practice more).
- All core contracts are upgradeable proxies (`initialize`, `__gap`, `getOrDeployProxy` in `deploy/`). The implementation can change under Trozu. Goes into `KNOWN_LIMITATIONS.md`. Slots and admins are recorded in [Proxy implementation slots](#proxy-implementation-slots).
- The oracle is a chain precompile, not a mock: `PriceFeed.fetchPrice` delegates to an implementation that calls `latestRoundData` on `0x7b7c000000000000000000000000000000000015`, which forge's EVM does not implement (`NotActivated`). Fork tests must mock `fetchPrice`. The price on matsnet is currently 84 127.77 USD.
- The docs "Chains Configuration" page lists different RPC hostnames (`testnet-rpc.mezo.org`) and chain ids. They conflict with the config page and with the live node. I use the values above, which were confirmed on chain.
- Compiler constraints: MUSD pins `0.8.24` with `evmVersion: london` (`hardhat.config.ts:73-75`). Mezo docs say 0.8.28 with `london`. **Design impact:** set `evm_version = "london"` in `foundry.toml`. No `PUSH0`, no transient storage (so no OZ `ReentrancyGuardTransient`), no `mcopy`. Pin OZ to a version that compiles under london.

## Stale hints in SortedTroves

Question: does a wrong or out-of-date hint revert, or only cost gas? This decides whether the UI must recompute hints right before sending.

From the source (`SortedTroves.sol:413-482`): `_findInsertPosition` validates each hint. A hint that is not in the list (`!contains`), or whose NICR is on the wrong side of the new NICR, is replaced by the zero address. With both hints dropped it walks the list from the head (`_descendList(data.head)`); with one hint left it walks from that node. Nothing reverts because of a bad hint. A revert only comes from the later checks in `_insert` (list full, node already present, zero id or zero NICR).

Measured on live matsnet (282 troves) with `script/measure/hints.sh`: `eth_estimateGas` of `openTrove(1800 MUSD, ...)` with 0.036 BTC, sent from a funded address that has no trove. Read only.

| Hints | Gas |
|---|---|
| correct (from `getApproxHint` then `findInsertPosition`) | 602,522 |
| previous neighbour only | 611,374 |
| next neighbour only | 613,377 |
| neighbours swapped | 627,716 |
| no hints | 4,530,482 |
| non-member address | 4,533,393 |
| head as both hints | 4,538,966 |
| tail as both hints | 2,230,023 |

Answer:
- **Stale hints are safe, never a revert.** A hint that is slightly off (a neighbour, or the neighbours swapped) costs almost nothing extra.
- **A useless hint costs about 7.5 times the gas** at today's size, because the walk calls `getNominalICR` once per step. It grows with list length.
- **UI rule:** compute hints with `getApproxHint` then `findInsertPosition` when the user confirms, not when the form is opened, and always pass them. Do not treat a failed hint as an error to show. Recomputing right before sending is a gas optimisation and a guard against hitting a block gas limit as the list grows; it is not needed for correctness.
- The same applies to the vault's `upperHint` and `lowerHint` arguments, which pass straight through.
- The NICR to search for is the one after the operation, `coll * 1e20 / principal`, not the current one.

## Proxy implementation slots

Read with `script/measure/proxy_slots.sh` (EIP-1967 implementation and admin slots, then `owner()` of each admin).

| Contract | Implementation | Admin (ProxyAdmin) |
|---|---|---|
| ActivePool | 0xbfc8201773bc17cc17e34a9eb4056cd5b7358192 | 0xe1a5fc495197f7918069f89ae1bc043d43063b68 |
| BorrowerOperations | 0xc05bf344bd5b58825784326dd3112fb6cc160dcc | 0x987dce741cb2608389f3aeb36dc651273b7531bb |
| BorrowerOperationsSignatures | 0xeec635ab00463a4a803de38c9d858a0fe3bdc235 | 0xb38d20e9f25a94110747ad24a436d819189466d4 |
| CollSurplusPool | 0x13af349efde2a7ff4469ef1f98126ffd57c32806 | 0x815df625b084bdf65698c313a1a7e7987a37be69 |
| DefaultPool | 0xa76a2c7869a82afc7f547b467393709251b4b141 | 0xd19495894c7583123a32dd46aeaf7ba5f3ad3df8 |
| GasPool | 0x46c5bc542166b0918d1ccadc8f101517323052eb | 0xd435e0318e0b97d74f2a5d08a2dd9103310f8e3f |
| GovernableVariables | 0x4edc83c5c5b0c41a594371485554b95280653f94 | 0xf7e10ed784543d827431b3e3776b887a9eb6bb4a |
| HintHelpers | 0x8adf3f35dbe4026112bcfc078872bcb967732ea8 | 0x7925337259ed8c78361aa9b5b143688079ad386c |
| InterestRateManager | 0xaa13b1d9cffa3f44ab3a8be0dc8774fb7841459c | 0x1306df8eef89e1de84745dae377d52c7535cd573 |
| PCV | 0xe641ab3c04140f3e3befcf60f8eed8ad6e31c300 | 0xde63cb80c897430b21d9bebb9d65c5c33bcccb97 |
| PriceFeed | 0xec42b37c12b8d73d320f4075a1bcd58b306629c1 | 0xc723d139e7ce77b86423b43ebc7f170b0e182be4 |
| SortedTroves | 0x9177df58a9614b84c8c2f68df27506ab9a5d0323 | 0x8d0d03185eb28afa93aadd3fbff5c6c610c43652 |
| StabilityPool | 0x8f0ca419bb1d54af4bf6a644f605cc247d6d3e19 | 0x1842610a553d1bea61335739c7008987b556ec9f |
| TroveManager | 0x9aab567966983e95536fc460c12266fb0cc10b07 | 0x934360dbe9595bcfc6b7e3d249d62902ac4b31cc |
| MUSD | not a proxy (both slots zero) | none |

- All 14 are transparent proxies, each with its own ProxyAdmin. MUSD itself is a plain contract.
- **Every ProxyAdmin on matsnet is owned by one address, `0x123694886DBf5Ac94DDA07135349534536D14cAf`, and it has no code, so it is an EOA.** One key can replace any core contract on testnet. Mainnet governance was not checked. This is the concrete form of THREAT_MODEL T14.
- The implementation addresses are a snapshot taken on 2026-10-21. Re-run the script before a release and compare. I did not verify that the implementation bytecode matches the pinned source at `aa25fd6`; the local tests assume it does. A bytecode comparison against the compiled artifacts is still open.

## The public RPC serves reads from nodes at different heights

Seen on 2026-10-22 while testing the transfer: repeated `eth_blockNumber` calls to `https://rpc.test.mezo.org` returned 16,296,884 and 16,082,514, about 214,000 blocks apart. A read that lands on the older node sees none of the recent state: `positionInfo` returned `0x` (no code at the lens), and one `eth_call` reported "Contract code is empty". Writes and later reads on the newer node were fine. Separately, about one request in twenty from this machine dies with a TLS error.

Consequences for Trozu: the UI must treat a failed or empty read as retryable, not as "no positions" (it shows its error state with a retry button), and must not conclude that a transaction failed because the next read looks unchanged. Tests and scripts that read right after a write should retry.

## Faucet and affordability

- Faucet: `https://faucet.test.mezo.org/`. The page offers BTC and MEZO and is protected by a Cloudflare Turnstile captcha. **I could not read the drip size**: it is not on the page or in the docs, and a claim needs a browser and a human. Please make one claim and tell me the amount and any cooldown; the table below then gives the position count.
- Cost of one position at the live parameters (price 84 127.77 USD, borrowing fee 0.1%, gas reserve 200 MUSD, minimum net debt 1800 MUSD). Composite debt is 2000 MUSD at the minimum.

| Target ICR | Collateral for the minimum position |
|---|---|
| 115% | 0.0273 BTC |
| 150% | 0.0357 BTC |
| 200% | 0.0476 BTC |

  So positions = floor(drip / 0.0357) at a safe 150%, or floor(drip / 0.0273) at the tightest sensible 115%. Gas on Mezo is paid in BTC and is small next to this.
- **A trove cannot be closed with the MUSD it minted.** Opening with 1798.2 MUSD of debt mints 1798.2 MUSD to the holder, but closing needs `debt - 200` = 1800 MUSD plus interest. Each position is short by about 1.8 MUSD plus accrued interest. For the demo, open a second position and borrow slightly more than needed, or acquire MUSD another way, to be able to demonstrate `close`.
- No MUSD faucet exists, so every test MUSD comes from a trove.

## 9. Integrations for composability points (partial, nothing built)

- **Mezo Passport** (`@mezo-org/passport`, latest 0.17.2 on npm): built on RainbowKit with wagmi and viem; peer deps `viem ^2.22.8`, `wagmi ^2.5.12`, `react ^18.2.0`, `@tanstack/react-query ^5.28.4`, `@rainbow-me/rainbowkit ^2.0.2`. Cheap: it is the frontend wallet layer for Phase 6. **Constraint:** peer `react ^18`, so the Next.js app has to stay on React 18, which affects the version of Next. Cheap, high value for the Mezo Integration criterion.
- **Mezo Earn** (`mezo-org/tigris`): Solidly-style ve system. `Escrow.sol` is an ERC-721 with `createLock`, `createLockFor`, `approve`, `transferFrom` (`solidity/contracts/ve/Escrow.sol`), plus `VeMEZO.sol`. veBTC and veMEZO locks are NFTs, so a Trozu vault could in principle hold or point at a lock. Deployment folders exist for `mainnet` and `testnet`. I have not read the testnet addresses or the lock/vote rules. **Open**; medium cost. Not in Wave 1.
- **NTT / Wormhole MUSD bridge:** docs say MUSD moves cross-chain via Wormhole Native Token Transfer (docs: Wormhole MUSD Bridge). The docs page is a stub. Base, BSC and Ethereum deployments exist in `solidity/artifacts/deployments/`. For Trozu the only relevant fact is that MUSD on other chains has no CDP (the `*NoOp` contracts under `artifacts/deployments/base/`). So no cross-chain positions. Low value, skip.
- **dApp requirements for the Mezo Market** (docs): MUSD integration, a third-party audit, and mainnet functionality. Relevant to the viability pitch: the roadmap should name the audit.

## Open items

1. Whether the deployed implementation bytecode equals the pinned source (slots are recorded, the comparison is not done).
3. Mezo Earn testnet addresses and lock transfer rules.
4. Mainnet trove count, to size the buffer cap.
5. How liquidation payouts are split exactly. Constants say 200 MUSD plus 0.5% of collateral (`PERCENT_DIVISOR = 200`) go to the liquidator; I read `_getOffsetAndRedistributionVals` (`TroveManager.sol:1564-1610`) and `_sendGasCompensation` (`:939-951`) but not the liquidation totals code.

## Design decisions this changes

- Vault `receive()` plus `nonReentrant` everywhere BTC moves; no state reads from inside `receive`.
- Vault `claimSurplus()`; Lens reports surplus.
- Refinance wrapper takes `maxFee` and an `expectedGlobalRate`, and reverts unless the new rate is strictly lower (by the guardian's X bps).
- The Lens and the marketplace read `getEntireDebtAndColl`, never the plain getters.
- Marketplace commitments are bounds checked at settlement, with a short deadline. Interest keeps growing, so `maxDebt` must have headroom.
- Guardian does not use `BorrowerOperationsSignatures`.
- Foundry with `evm_version = "london"`; no `PUSH0`, no transient storage.
