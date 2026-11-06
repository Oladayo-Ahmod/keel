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

Both NFTs are held by the deployer. After the opens the wallet holds 0.018983 BTC and 3,700 MUSD. The MUSD from position 2 is what lets position 1 be closed: closing needs about 1,802 MUSD.

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
