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
