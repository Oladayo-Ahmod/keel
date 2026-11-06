# Deployments

## Mezo testnet (matsnet, chain id 31611)

Deployed 2026-10-22 from `0x5104C1A69242D94159Cf7151277252e568cB8F98`.

| Contract | Address | Deploy tx |
|---|---|---|
| PositionFactory | `0xCDf7E1a6Be19EcE762477Cf89c786B9216307405` | `0xe54502fd3f0dd36be8c53faa462ac7ee713b934adb129b2cd860ec08e78d6adc` (block 16294264, 3.89M gas) |
| PositionNFT (created by the factory) | `0xEF892989eAa3acB203803aA8b4946a40815F948C` | inside the factory tx |
| PositionVault implementation (created by the factory) | `0x7A546Ba684D8A7bdcA408F4f2e65e4E3F112208E` | inside the factory tx |
| PositionLens | `0x5e499cA8643cB4aB56a2E0A6E34De3DFb8DfFBD9` | `0xe3de1de4e3128016971097bde3e963fa58165e9d22094d2cb7105cbe8c526323` (block 16294265, 1.41M gas) |

**Source verification.** All four contracts are verified on Sourcify with an exact match, chain 31611:

| Contract | Sourcify |
|---|---|
| PositionFactory | [exact match, runtime and creation](https://repo.sourcify.dev/31611/0xCDf7E1a6Be19EcE762477Cf89c786B9216307405) |
| PositionNFT | [exact match](https://repo.sourcify.dev/31611/0xEF892989eAa3acB203803aA8b4946a40815F948C) |
| PositionVault implementation | [exact match](https://repo.sourcify.dev/31611/0x7A546Ba684D8A7bdcA408F4f2e65e4E3F112208E) |
| PositionLens | [exact match](https://repo.sourcify.dev/31611/0x5e499cA8643cB4aB56a2E0A6E34De3DFb8DfFBD9) |

Blockscout (explorer.test.mezo.org) still shows them as unverified. I tried the Etherscan-style call, `forge verify-contract` with the Blockscout verifier, the same with the exact compiler version (`v0.8.24+commit.e11b9ed9`), 100 optimizer runs, `london` and the deploy-time metadata settings, the v2 standard-input endpoint and the v2 flattened endpoint. Every one returned `Fail - Unable to verify` with no detail (backend v6.9.2-beta). The cause is on the explorer side as far as I can tell: the same inputs give an exact match on Sourcify.

Independent of any explorer, `script/check_bytecode.sh` compares the creation input of the factory and lens transactions with what a checkout compiles to, and both match byte for byte. The factory's creation input embeds the NFT and the vault implementation, so those are covered too:

```
script/check_bytecode.sh 0xe54502fd3f0dd36be8c53faa462ac7ee713b934adb129b2cd860ec08e78d6adc \
  0xe3de1de4e3128016971097bde3e963fa58165e9d22094d2cb7105cbe8c526323 \
  0xEF892989eAa3acB203803aA8b4946a40815F948C
```

To verify on Sourcify again, for example after a change: `forge verify-contract <address> <path>:<name> --verifier sourcify --chain-id 31611 --compiler-version 0.8.24 --num-of-optimizations 100 --evm-version london --constructor-args <abi-encoded>`. Constructor arguments are the same as in `script/check_bytecode.sh`.

### Demo positions

Opened with `script/open_demo.sh` at an oracle price of 82,056 USD.

| | Position 1 | Position 2 |
|---|---|---|
| NFT id | 1 | 2 |
| Vault | `0x1D5acd83cd4D87F26533A364394e206199af7464` | `0x9424d2956D8b99EfB28b2A22C28dBE9A98c93f0d` |
| Debt requested | 1,800 MUSD | 1,900 MUSD |
| Collateral | 0.039033 BTC | 0.040984 BTC |
| ICR when read (price 82,123) | 160.13% | 160.13% |
| Locked rate | 1.00% | 1.00% |
| Open tx | `0xb4dd89a469800aa39dcc62988048eb215649c748c59f518e26c7d830b3e2f244` | `0xa36744dd04e237370c3f7f6cdf23ecb0bcd52e8a39da9e72f9b418bf83ed279f` |
| Gas | 929,518 | 900,930 |

**Position 1 was closed on 2026-11-06.** Its 0.039033 BTC of collateral funded the Wave 2 proof run (see the Wave 2 section). Approve tx `0x00add10ae2c98e3dabbbd3221ec282ff4776484077e385caf5b7f7899e97da5f`, close tx `0x5a9f7b359a7ebbb3b023820ef5a66b4daeacb9f7e9092c3fdf46d86eadd845e7` (block 16,611,968). Closing cost 1,802.64 MUSD, leaving the deployer 1,897.36 MUSD and 0.057016 BTC. NFT 1 still exists; its trove status is `closedByOwner`. Position 2 is unchanged and is the Wave 1 demo position from now on.

Both NFTs were held by the deployer. After the opens the wallet holds 0.018983 BTC and 3,700 MUSD. The MUSD from position 2 is what lets position 1 be closed: closing needs about 1,802 MUSD.

Trozu is bound to these Mezo contracts (see [VERIFICATION.md](VERIFICATION.md)): BorrowerOperations `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5`, TroveManager `0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0`, SortedTroves `0x722E4D24FD6Ff8b0AC679450F3D91294607268fA`, InterestRateManager `0xD4D6c36A592A2c5e86035A6bca1d57747a567f37`, CollSurplusPool `0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9`, ActivePool `0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51`, PriceFeed `0x86bCF0841622a5dAC14A313a15f96A95421b9366`, MUSD `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`.

## Reproduce

The deployer key is read from the environment and is never written to a file in the repository. A gitignored `.env` works: `set -a; . ./.env; set +a`.

```
export DEPLOYER_PRIVATE_KEY=0x...
forge script script/Deploy.s.sol --rpc-url https://rpc.test.mezo.org --broadcast --skip-simulation
```

`--skip-simulation` is needed because the Mezo price feed calls a chain precompile that forge cannot simulate. The deploy script never touches the price feed, so a dry run without `--broadcast` also works (estimated 6.9M gas, the real run used 5.3M, the block limit is 10M).

The public RPC drops some connections. Before running again after a failure, check the nonce with `cast nonce <deployer> --rpc-url https://rpc.test.mezo.org`, because a dropped response does not mean the transaction was not sent.

### Demo positions

`forge script` cannot open positions on matsnet. A script runs the broadcast calls in forge's own EVM first, and opening a trove reads the price precompile, which that EVM lacks. A first version of this runbook used a forge script for it; it hung and never sent anything. A shell version put the key on the command line, so both were replaced by `web/scripts/demo.ts`, which uses viem and reads the key from `ETH_PRIVATE_KEY` only:

```
cd web
export ETH_PRIVATE_KEY=0x...        # never as an argument, never in a file in the repo
npx tsx scripts/demo.ts status
DRY_RUN=1 npx tsx scripts/demo.ts open     # sizing and hints only
npx tsx scripts/demo.ts open               # the two demo positions
npx tsx scripts/demo.ts close 1            # approve the vault for the MUSD it needs, then close
npx tsx scripts/demo.ts transfer 2 0x...   # safeTransferFrom
```

`open` refuses a target ICR under 150% (`TARGET_ICR`, default 1.6) or a budget that leaves less than `RESERVE` (default 0.015 BTC). Hints are computed right before each send. A trailing carriage return in a `.env` file broke key parsing once, so the script trims whitespace and quotes. A script that sends never retries blindly: if the wallet nonce moved after a failed send it stops and says so.

### Transfer, checked live

On 2026-10-22 position 2 was moved with `safeTransferFrom` to a throwaway address and back:

| Step | Tx |
|---|---|
| gas for the throwaway receiver, 0.001 BTC | `0x074b1200212459155b09713053f3028cd743d54a0b48e1d3c05fe5587bb4eb11` |
| #2 deployer to receiver, 92,024 gas | `0x8f6333d4d33da8081ce25d064f4b9349216bf52ff0e247882c75614c157e0299` |
| #2 receiver back to deployer, 92,024 gas | `0xf3bf6eae1f23703eb5163d088f373e11694d36debe39392ffd94b510a40a2266` |

While the receiver held it, the lens showed the receiver as holder with the same collateral, debt and rate, `transferEpoch` was 2, and the deployer's holder calls on the vault reverted with `NotHolder` (`0x7623fb52`). After the transfer back, epoch 3, the receiver was locked out the same way and the deployer's calls worked. The receiver's key was deleted, so about 0.001 BTC of the gas money is stranded at `0x0f086b6c73374dC1c6653ED50746A3C27bf707d4`.

This exercised the contracts, not the web UI. The UI builds the same call, and simulates it first; I could not drive a browser wallet from here.

### Demo plan for the remaining BTC

State on 2026-10-22: wallet 0.017983 BTC and 3,700 MUSD, positions 1 and 2 both at about 160%. The oracle price moves, so amounts below are approximate.

1. **Close position 1** with the 3,700 MUSD: `npx tsx scripts/demo.ts close 1`. It approves the vault for about 1,803.6 MUSD (the close cost 1,801.81 plus a 0.1% cushion for interest while the transaction is mined), then calls `close()`. A dry run with a faked allowance simulates fine. Expected: MUSD about 1,898.2 (3,700 minus the 1,801.8 repaid), BTC about 0.0570 (0.017983 plus the 0.039033 collateral, less gas). NFT #1 stays in the wallet with no trove. The 200 MUSD liquidation reserve is returned by Mezo burning it from its own pool, so it costs nothing extra.
2. **Reopen through the web app's Open flow**: debt 1,800 MUSD, press the 160% ratio button, review, confirm. At 82,000 USD that is about 0.0390 BTC and mints 1,800 MUSD. Expected: MUSD about 3,698.2, BTC about 0.0181, a new NFT #3 at about 160%.
3. **Transfer** NFT #2 or #3 from the card's Transfer button to a second wallet, type the last four characters of its address, and confirm.

Closing needs the wallet to hold at least `debt - 200` MUSD plus a little interest. That is why position 2 borrows 1,900.

## Verify

See the status at the top. For Blockscout the command is `forge verify-contract <address> <path>:<name> --verifier blockscout --verifier-url https://api.explorer.test.mezo.org/api --chain-id 31611 --constructor-args <abi-encoded>`; it is kept here so someone can retry when the explorer is fixed.

## Testnet budget

The faucet gave 0.099 BTC. The plan was a 160% target ICR (never below 150%), the two positions and a reserve of at least 0.015 BTC. Actual use: 0.080 BTC for collateral, under 0.000001 BTC for gas, 0.0190 BTC left.

Position 2 borrows 100 MUSD more than the minimum on purpose. After both opens the wallet holds 3,700 MUSD, and closing position 1 needs `debt - 200`, about 1,802 MUSD plus a little interest. Sorted-list hints are computed right before sending; a stale hint would only cost gas (see [VERIFICATION.md](VERIFICATION.md#stale-hints-in-sortedtroves)).

## Naming

The project was called KEEL in Wave 1 and is now Trozu. The Wave 1 contracts above are immutable and unchanged, so the on-chain NFT is still named "KEEL Position" with symbol "KEEL". The repository URL and the Vercel domain also keep the old name. New deployments from Wave 2 use the Trozu name and symbol.

## Wave 2: Mezo testnet (matsnet, chain id 31611)

Deployed 2026-11-06 from `0x5104C1A69242D94159Cf7151277252e568cB8F98` with `script/DeployV2.s.sol`. The Wave 1 contracts above are untouched; these are new deployments bound to the same Mezo testnet core. Fee recipient is the deployer address, because no other address was specified; it is an immutable and cannot change. Fee 25 bps (the contract refuses more than 100). Per-position debt cap: none (0).

| Contract | Address | Deploy tx |
|---|---|---|
| TrozuFactory | `0x70791379537cB14981AA7114678663164141eC31` | `0xe7bae178b3cb667d81aeb941ae717f0465b93abd43269c18295ae9f791b6903a` (block 16611690, 7.63M gas) |
| TrozuNFT ("Trozu Position", `TROZU`), created by the factory | `0xd53f649e4df31351De8935De9cA7110888F055b8` | inside the factory tx |
| PositionLens bound to the Trozu NFT, created by the factory | `0xCCF8c5aFe7473eC41F64906071e1bE497872004C` | inside the factory tx |
| TrozuVault implementation, created by the factory | `0x6ef4395325828083672FFe836d6Bc80Bf22cACFE` | inside the factory tx |
| TrozuMarket | `0xEae6fEa26B178eF32829F36e5219363bB30D93DB` | `0xd4643026ede31329f68538261b9ff274a7b185e31acbf5422630189d9908a37a` (block 16611692, 2.06M gas) |

**Source verification.** All five report an exact runtime match on Sourcify, chain 31611 (the three created inside the factory have no creation transaction of their own, so only the runtime is matched). Re-run with `script/verify_v2.sh`.

| Contract | Sourcify |
|---|---|
| TrozuFactory | [exact match](https://repo.sourcify.dev/31611/0x70791379537cB14981AA7114678663164141eC31) |
| TrozuNFT | [exact match](https://repo.sourcify.dev/31611/0xd53f649e4df31351De8935De9cA7110888F055b8) |
| PositionLens (Trozu) | [exact match](https://repo.sourcify.dev/31611/0xCCF8c5aFe7473eC41F64906071e1bE497872004C) |
| TrozuVault implementation | [exact match](https://repo.sourcify.dev/31611/0x6ef4395325828083672FFe836d6Bc80Bf22cACFE) |
| TrozuMarket | [exact match](https://repo.sourcify.dev/31611/0xEae6fEa26B178eF32829F36e5219363bB30D93DB) |

Blockscout (explorer.test.mezo.org) was not tried again; Wave 1's Blockscout verification failed for explorer-side reasons.

The deployment is from commit `4e00aac` (after the review fixes). The vault implementation is 21,122 bytes of runtime, under the 24,576 limit.

### Wave 2 live proof and demo state (2026-11-06)

Created by `npm run proof` in [`keeper/`](../keeper). Every transaction, with its hash, is in [PROOF.md](PROOF.md); [`proof.json`](proof.json) is the same data for the app.

| | Address / id |
|---|---|
| v2 position | NFT id **1** on the Trozu NFT, vault `0x2B08BB7F73beD0FA0454907a7E7082F1a58d9AB9`, opened in tx `0x3c8456df1c02b699565fed0076fb02bc8970ff495b7b7bd198f4e76e33dc2c15` |
| Holder (also seller and fee recipient) | deployer `0x5104C1A69242D94159Cf7151277252e568cB8F98` |
| Second wallet (buyer) | `0xf8B5CF0292C4e5202CC9a9e6041FD59F692edEe2` (a generated testnet key, in `.env` as `SECOND_PRIVATE_KEY`, 0.002 BTC for gas) |
| Keeper | `0x7a24528a52E59dF9Dde2E9655a8FC9d1E4601C5c` (generated, `KEEPER_PRIVATE_KEY`, 0.002 BTC for gas) |

What was proven on chain: open, transfer away and back, announce, a fixed-price sale with MUSD permit (100 MUSD, fee 0.25 MUSD), a cancel, a Dutch-auction sale (115.67 MUSD between a 120 start and a 60 floor), a guardian ratio-floor top-up by the keeper, and a redemption-defense top-up by the keeper after a complete walk. Nine refusals are recorded as `eth_call` results with the contract's real revert.

**Current state of the staged position.** Held by the deployer, ratio about 127.9%, a live guardian policy (redemption defense, floor 112%, buffer floor 10,000,000 MUSD, so it will act again whenever the walk completes), and 0.001188 BTC left in its reserve. It is the "guarded position". It is close enough to liquidation (110%) that a moderate oracle move would matter, so it is a demo position, not a safe one.

**Funds used.** Position 1 of Wave 1 was closed to fund this (see above): 0.057016 BTC and 1,897 MUSD afterwards. The proof used 0.0351 BTC net across the new position and its reserve, plus 0.004 BTC for the two wallets and negligible gas (146 wei per gas). The deployer now holds 0.017890 BTC and 3,513 MUSD, which keeps the 0.003 BTC reserve.

**Failed transactions, kept in the record.** Three things went wrong and none moved funds:
1. A keeper `execute` (tx `0x1002b8e1…2e60`, block 16,612,677) ran out of gas at a limit of 25,584: the node's `eth_estimateGas` answered about 21,300 where the call needs about 5.6M. The keeper now sends with at least 6M of gas limit (the unused part is not charged).
2. A second keeper `execute` (tx `0xae438464…722c`, block 16,612,964) used 5.58M of a 6M limit and ran out of gas: the redemption-defense path adds a 100-step walk and the keeper had sent no sorted-list hints. The keeper now computes hints and the retry succeeded.
3. One of my own `setPolicy` transactions was rejected by the node before inclusion for a gas limit below the data-gas floor, same cause as the first.

**Judge staging: not done, and why.** The brief asked for a few listings at different prices, one running Dutch auction and one guarded position. Only the guarded position exists. Each additional position needs at least 0.029 BTC of collateral (Mezo's 1,800 MUSD minimum at the 110% floor, about 0.036 BTC at a sensible 135%), and after the proof the deployer holds 0.0179 BTC with 0.003 to keep. Missing, and what it would take:

| Item | Status | Needs |
|---|---|---|
| Listings at different prices | not staged | one more position per listing, about 0.036 BTC each |
| A running Dutch auction | not staged | one more position, about 0.036 BTC (listing the guarded position would risk a judge's purchase killing its policy) |
| A guarded position | **staged** (above) | nothing |

Three more positions would take about 0.11 BTC. A faucet top-up of that size would allow it; the proof script can be reused for the listings.

**Keeper schedule.** `.github/workflows/keeper.yml` runs every 15 minutes. It needs a repository secret `KEEPER_PRIVATE_KEY` (the keeper key above, or a new dedicated one). Without the secret it runs as a dry run. I have not set any secrets and cannot; the key is only in `.env`, which is git-ignored.
