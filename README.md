# KEEL

Tradable MUSD positions on Mezo.

A MUSD trove is bound to one address and cannot be transferred. KEEL puts each trove inside a small vault contract and represents the vault as an ERC-721. Whoever holds the NFT controls the trove, so a position (collateral, debt and its locked interest rate) can be sent, gifted or sold as one object.

Status: wave 1 of the Mezo Buildathon. Contracts and tests are done, the contracts are deployed on Mezo testnet (addresses in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md)), and the web app has the positions view, an open-position flow and an NFT transfer flow. See [docs/TEST_PLAN.md](docs/TEST_PLAN.md) for what is covered and what is not.

## What is in wave 1

- `PositionFactory` opens a position: clones a vault, opens the trove, mints the NFT.
- `PositionVault` is the trove owner. Every call checks `ownerOf` on the NFT, and funds only go to the caller. It wraps open, add and withdraw collateral, borrow, repay (with permit), adjust, refinance, close (with permit), claim surplus.
- `PositionNFT` is an enumerable ERC-721 that also keeps a transfer epoch per token.
- `PositionLens` is a read-only view: ICR, equity, locked versus global rate, rate spread, claimable surplus, and a redemption buffer.

The refinance wrapper only allows a strictly lower rate and enforces a fee cap, because Mezo's own `refinance` will move a trove to a higher rate. The redemption buffer is a lower bound unless the walk completes; the Lens says which.

Wave 2 adds a state-committed marketplace and a policy-bounded guardian. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
holder -- ownerOf --> PositionNFT <--mint-- PositionFactory
                          ^                      | clone + open
                          | ownerOf            v
                      PositionVault  --------> Mezo MUSD core
                                              (BorrowerOperations, TroveManager, SortedTroves, pools)
PositionLens (views) -----------------------> vault, TroveManager, SortedTroves, PriceFeed
```

## Documents

| File | Contents |
|---|---|
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | What the MUSD contracts actually do, with file and line references, and live matsnet measurements |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, rules and wave 2 hooks |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | Threats T1 to T22, mitigations and tests |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Design decisions and reasons |
| [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) | What KEEL does not do or cannot control |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Test layers, coverage, open items |

## Deployed

Mezo testnet (chain id 31611): factory `0xCDf7E1a6Be19EcE762477Cf89c786B9216307405`, lens `0x5e499cA8643cB4aB56a2E0A6E34De3DFb8DfFBD9`, NFT `0xEF892989eAa3acB203803aA8b4946a40815F948C`. Everything, with tx hashes, is in [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

All four contracts are verified on Sourcify with an exact match. Blockscout would not accept the same inputs. To check a deployment without trusting any explorer, [script/check_bytecode.sh](script/check_bytecode.sh) compares the creation input of the deploy transactions with what this checkout compiles to.

## Web app

`web/` is a Next.js 14 app (React 18, which Mezo Passport requires) with wagmi, RainbowKit through Mezo Passport, and anime.js. Every address is read from `web/src/config/deployment.json`.

```
cd web
npm install --legacy-peer-deps   # Passport's own dependencies declare old React peers
npm run dev                      # http://localhost:3000
npm test
```

Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to your own WalletConnect project id for wallet connections. The positions view shows collateral ratio on a gauge, locked against market rate, and the redemption buffer on demand. A position can also be looked up by NFT id with no wallet (`/?id=1`).

- **Open a position:** amounts and a target ratio, a review step, then sorted-list hints are looked up at the confirm step, the call is simulated, and only then does the wallet prompt appear. The app refuses under 120% and warns under 150%.
- **Transfer a position:** the card's Transfer button. It shows ratio and equity first and needs a typed word for an underwater or low-ratio position, asks for the receiver, flags a contract receiver, requires the last four characters of the address, simulates `safeTransferFrom`, then sends it.
- Pending, success and failure states link the transaction hash to the explorer. Motion respects `prefers-reduced-motion`.

`web/scripts/demo.ts` drives the same contracts from a terminal (open, close, transfer, status) with the key in `ETH_PRIVATE_KEY`. `web/scripts/measure-overflow.mjs` checks for horizontal overflow at 390 and 360 px.

## Build and test

Needs [Foundry](https://getfoundry.sh). Submodules hold the pinned MUSD source and OpenZeppelin.

```
git clone --recurse-submodules https://github.com/Oladayo-Ahmod/keel
cd keel
forge test
```

Tests deploy the real MUSD contracts (pinned at `aa25fd6`) locally and replace only the oracle. A deeper invariant run: `FOUNDRY_PROFILE=deep forge test --match-contract Invariants`.

Mezo runs the `london` EVM, so `foundry.toml` pins `evm_version = "london"` and solc 0.8.24.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). The vendored MUSD contracts in `lib/musd` are GPL-3.0 and the test suite compiles and deploys them, so the repository uses the same license rather than argue about the boundary. `@mezo-org/passport` in the web app is GPL-3.0-only, which is also compatible. OpenZeppelin is MIT and compatible.

## Not audited

This code has not had a third-party audit. Read [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) first.
