# Decisions

Each entry: what was decided and why. Newest last.

1. **Foundry, not Hardhat.** Fuzz, invariant and fork testing are built in. Trozu only calls deployed Mezo contracts through interfaces, so MUSD's Hardhat tooling is not needed.
2. **`solc 0.8.24`, `evm_version = london`.** Mezo runs `london` and MUSD pins 0.8.24 (`hardhat.config.ts:73-75`). No `PUSH0`, transient storage or `mcopy`, so no `ReentrancyGuardTransient`.
3. **One vault clone per position, vault is the trove borrower.** A trove is bound to its borrower address and one address has at most one trove (`BorrowerOperations.sol:1140-1148`). An NFT cannot move a trove, so it moves the contract that owns it.
4. **Vault authority is `nft.ownerOf` at call time and nothing else.** No stored owner, operator or delegate. A transfer therefore resets all permissions without any write.
5. **Funds always go to `msg.sender`.** No caller-supplied recipient. It removes a class of redirect bugs and makes the payout target the holder by construction.
6. **MUSD is pulled from `msg.sender` only.** A seller's leftover allowance to the vault cannot be used by the new holder.
7. **`receive()` accepts BTC only from ActivePool and CollSurplusPool and does nothing.** Mezo sends BTC with a raw call and explicitly allows re-entry (`SendCollateral.sol:11`).
8. **Forward BTC by balance delta.** Forced sends cannot be mixed into an operation's payout.
9. **`ERC721Enumerable`.** Lets the UI list a wallet's positions without an indexer. Extra gas on transfer is accepted.
10. **`transferEpoch` in the NFT.** Wave 2 listings and guardian policies key off it, so a transfer voids them with no cooperation from the vault.
11. **Refinance wrapper requires a strict rate drop and a fee cap.** Mezo's `refinance` moves a trove to the current global rate even when that is higher, and has no slippage argument (`BorrowerOperations.sol:1069-1075`).
12. **All debt and collateral reads use `getEntireDebtAndColl`.** The plain getters exclude pending redistribution.
13. **Redemption buffer is a lower bound with `complete` semantics.** Only a complete walk can prove it small. Any future trigger uses complete-walk semantics.
14. **Guardian is wave 2 and needs a vault v2 behind a new factory.** A delegate slot in wave 1 would be unused attack surface.
15. **No use of `BorrowerOperationsSignatures`.** It checks ECDSA only, and the borrower is a contract.
16. **Core addresses are immutables.** A Trozu deployment is bound to one Mezo deployment. Fewer storage reads and no admin to compromise. Cost: a Mezo redeploy needs a Trozu redeploy.
17. **Measure gas server side, not on a local fork.** The public matsnet RPC drops a few percent of connections from some networks, and a fork run makes thousands of sequential requests, so it did not finish in 45 minutes. `script/measure/BufferWalker.sol` runs the walk inside a constructor via `eth_call` and `eth_estimateGas`. Full fork tests will need a pinned block and a warm cache, or a different RPC provider.
18. **Default Lens walk cap is 100 steps.** Measured at about 24.7k gas per trove, so about 2.6M gas. A full walk of 281 troves is about 7M.
19. **Oracle is mocked in fork tests.** `PriceFeed.fetchPrice` calls a chain precompile that forge's EVM lacks (`0x7b7c…0015`).
20. **Test against the real MUSD contracts, deployed locally.** `lib/musd` is a submodule pinned to `aa25fd6`; only the oracle is replaced, and it uses the MockAggregator from the Mezo repository. A hand-made mock of the core would encode my reading of Mezo, which is the thing under test. Cost: a slower first compile.
21. **Mint the NFT last, and guard the factory.** `_safeMint` runs receiver code. By then the position is complete, and `nonReentrant` stops re-entry into the factory (T18).
22. **Permit is `try/catch` plus `transferFrom`.** A front-run permit cannot block the holder (T21).
23. **Wave 2 listings are off-chain EIP-712 orders with on-chain cancellation.** See T22.
24. **Vault v2 is a strict superset of v1.** The marketplace and UI treat both the same.
25. **OpenZeppelin 5.2.0 for both Trozu and the pinned MUSD sources.** One copy, and it compiles under `london`.

## Wave 2 (market and guardian)

26. **The market is non-custodial.** The position stays in the seller's wallet until a buyer settles. The seller approves the market on the NFT; a sale moves MUSD first and the NFT last. No escrow means no escrowed asset to lose, at the cost of the seller needing an approval and of listings that can go stale (handled by `transferEpoch`, the nonce and the buyer's bounds).
27. **Discovery is an event, not a server.** `announce(listing, signature)` re-checks the listing and emits it with the signature, so any indexer, and the app, can rebuild the order book from logs. Only a listing that would settle right now is accepted, so a spammer needs the seller's signature. Considered and rejected: an off-chain order book (a server we would have to run and users would have to trust) and on-chain storage of every listing (about 20k gas per slot, for no gain over logs). Cost: reading the book means scanning logs, and Mezo's public RPC caps `eth_getLogs` at 10,000 blocks, so the app scans in windows from the deployment block. Fine for a testnet deployment; a mainnet app should add a cache or an indexer.
28. **Fee is two immutables and one constant.** `FEE_BPS` and `FEE_RECIPIENT` are constructor arguments; the constructor reverts above `MAX_FEE_BPS = 100`. No owner, no setters, no pause. Default deployment is 25 bps. The fee rounds up, so the seller's share rounds down and the buyer never pays less than the price. On testnet the recipient is the deployer address because no other address was given; it cannot be changed after deployment.
29. **Settlement reads Mezo in the same transaction.** `buy` re-reads collateral, debt and locked rate from TroveManager and compares them with bounds the buyer chose. A seller who strips collateral or borrows more after signing cannot get a buyer's money.
30. **The guardian never refinances.** `docs/MARKET_DATA.md`: the global rate has never moved, all 641 opens and 215 refinances locked 100 bps. Automating refinance would be a feature with no data behind it. The manual `refinance` of the Wave 1 vault is kept unchanged.
31. **Guardian actions: ratio floor and redemption defense only.** Top up from the BTC reserve, repay from the MUSD reserve, or (defense) top up when a complete sorted-list walk proves the redemption buffer is below the holder's floor. An unknown verdict never acts.
32. **`targetIcr` is also a ceiling.** The guardian restores the ratio towards the target and does not push past it, so a holder who wants redemption defense on a healthy position sets a high target. Considered: a separate defense ceiling. Rejected as one more parameter to get wrong.
33. **The planner does not offer what Mezo would reject.** In normal mode Mezo reverts an adjustment that leaves a trove under 110%. `execute()` and `preview()` share one planning function, which returns `BelowMinimum` instead of an action that would revert, so a keeper does not pay gas for a doomed call. Consequence: the guardian cannot rescue a position already under 110% unless one action, within the caps, lifts it back over (recovery mode lifts the rule). Set the floor well above 110%.
34. **The reserve stays in the vault as plain BTC and MUSD.** Not in the MUSD savings vault. See `docs/INTEGRATION_SCAN.md`: it is not ERC-4626, funds go to a strategy the owner can change, and the keeper path should not depend on a third party's liquidity. Withdrawable by the holder at any time, whatever the policy says.
35. **Reserve accounting is explicit.** `reserveBtc` and `reserveMusd` are state. Between calls the vault holds exactly its reserve; `sweep` returns only the excess. Invariant I2 changed from "a vault holds nothing between calls" to "a vault holds exactly its reserve".
36. **Keeper tip is a fixed BTC amount, capped in code.** `MAX_KEEPER_TIP = 0.0001 BTC`, whatever a policy says, paid from the reserve only when the action succeeds, and counted against the period cap. If the reserve cannot cover it the tip is zero and the action still runs.
37. **Policy is keyed by `transferEpoch`.** A policy records the epoch it was set under and is dead the moment the token moves, including a move away and back. The new holder sets their own.
38. **Hints are untrusted arguments to `execute`.** Mezo uses them only as a starting point for its sorted-list search.
39. **v2 is copies, not subclasses.** `TrozuNFT` and `TrozuVault` are copies of the Wave 1 contracts with the additions, so Wave 1 source stays byte for byte as deployed (`script/check_bytecode.sh` still matches). The Wave 1 vault tests are re-run against the v2 vault by mechanical renames (75 tests), which is how "strict superset" is checked.
40. **Optional per-position debt cap, fixed at deployment.** `TrozuFactory(core, debtCap)` passes the cap to every vault; it is checked after opens, borrows and debt-increasing adjusts. Repaying and adding collateral are never blocked. Zero means none, which is what the testnet deployment uses. It exists for a capped mainnet launch, if that is ever approved.
41. **Fork tests pin block 13,040,764 and mock only `fetchPrice`.** The same pin as `docs/MARKET_DATA.md`. The oracle is a chain precompile a fork cannot run. Everything else, MUSD, BorrowerOperations, TroveManager and the live sorted list, is the real mainnet state.
