# Deployments

## Mezo testnet (matsnet, chain id 31611)

Deployed 2026-10-22 from `0x5104C1A69242D94159Cf7151277252e568cB8F98`.

| Contract | Address | Deploy tx |
|---|---|---|
| PositionFactory | `0xCDf7E1a6Be19EcE762477Cf89c786B9216307405` | `0xe54502fd3f0dd36be8c53faa462ac7ee713b934adb129b2cd860ec08e78d6adc` (block 16294264, 3.89M gas) |
| PositionNFT (created by the factory) | `0xEF892989eAa3acB203803aA8b4946a40815F948C` | inside the factory tx |
| PositionVault implementation (created by the factory) | `0x7A546Ba684D8A7bdcA408F4f2e65e4E3F112208E` | inside the factory tx |
| PositionLens | `0x5e499cA8643cB4aB56a2E0A6E34De3DFb8DfFBD9` | `0xe3de1de4e3128016971097bde3e963fa58165e9d22094d2cb7105cbe8c526323` (block 16294265, 1.41M gas) |

**Source verification on Blockscout: not achieved.** I tried `forge verify-contract` with the Blockscout verifier, again with explicit compiler settings, the v2 standard-input endpoint, the v2 flattened-source endpoint and the Etherscan-style `verifysourcecode` call. Every attempt returned `Fail - Unable to verify` with no further detail (Blockscout backend v6.9.2-beta). The explorer shows all four as unverified.

What I can show instead: `script/check_bytecode.sh` compares the creation input of the factory and lens transactions with what this checkout compiles to, and both match byte for byte. The factory's creation input embeds the NFT and the vault implementation, so those two are covered by the factory match. Run:

```
script/check_bytecode.sh 0xe54502fd3f0dd36be8c53faa462ac7ee713b934adb129b2cd860ec08e78d6adc   0xe3de1de4e3128016971097bde3e963fa58165e9d22094d2cb7105cbe8c526323   0xEF892989eAa3acB203803aA8b4946a40815F948C
```

The cause on the explorer side is unknown. I did not change the compiler settings or the code to chase it, since that would change the deployed bytecode.

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

KEEL is bound to these Mezo contracts (see [VERIFICATION.md](VERIFICATION.md)): BorrowerOperations `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5`, TroveManager `0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0`, SortedTroves `0x722E4D24FD6Ff8b0AC679450F3D91294607268fA`, InterestRateManager `0xD4D6c36A592A2c5e86035A6bca1d57747a567f37`, CollSurplusPool `0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9`, ActivePool `0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51`, PriceFeed `0x86bCF0841622a5dAC14A313a15f96A95421b9366`, MUSD `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`.

## Reproduce

The deployer key is read from the environment and is never written to a file in the repository. A gitignored `.env` works: `set -a; . ./.env; set +a`.

```
export DEPLOYER_PRIVATE_KEY=0x...
forge script script/Deploy.s.sol --rpc-url https://rpc.test.mezo.org --broadcast --skip-simulation
```

`--skip-simulation` is needed because the Mezo price feed calls a chain precompile that forge cannot simulate. The deploy script never touches the price feed, so a dry run without `--broadcast` also works (estimated 6.9M gas, the real run used 5.3M, the block limit is 10M).

The public RPC drops some connections. Before running again after a failure, check the nonce with `cast nonce <deployer> --rpc-url https://rpc.test.mezo.org`, because a dropped response does not mean the transaction was not sent.

### Demo positions

`forge script` cannot open positions on matsnet. A script runs the broadcast calls in forge's own EVM first, and opening a trove reads the price precompile, which that EVM lacks. A first version of this runbook used a forge script for it; it hung and never sent anything. Use the shell script, which sizes the positions, computes the sorted-list hints and sends with `cast`:

```
export FACTORY=0x...
DRY_RUN=1 script/open_demo.sh      # prints sizing and hints only
script/open_demo.sh
```

It refuses to run if the target ICR is under 150% (`TARGET_ICR_E18`, default 1.6e18) or if the two positions plus the reserve (`RESERVE`, default 0.015 BTC) do not fit in the wallet. It retries dropped connections only while the wallet nonce has not moved. The key is passed to `cast` on the command line, so it is visible in `ps` on that machine while a transaction is sent. `script/DemoPlan.sol` holds the same sizing as a tested pure contract.

## Verify

See the status at the top. The commands that were tried are `forge verify-contract <address> <path>:<name> --verifier blockscout --verifier-url https://api.explorer.test.mezo.org/api --chain-id 31611 --constructor-args <abi-encoded>`, with constructor arguments as in `script/check_bytecode.sh`. They are kept here so someone can retry when the explorer is fixed or can say why it fails.

## Testnet budget

The faucet gave 0.099 BTC. The plan was a 160% target ICR (never below 150%), the two positions and a reserve of at least 0.015 BTC. Actual use: 0.080 BTC for collateral, under 0.000001 BTC for gas, 0.0190 BTC left.

Position 2 borrows 100 MUSD more than the minimum on purpose. After both opens the wallet holds 3,700 MUSD, and closing position 1 needs `debt - 200`, about 1,802 MUSD plus a little interest. Sorted-list hints are computed right before sending; a stale hint would only cost gas (see [VERIFICATION.md](VERIFICATION.md#stale-hints-in-sortedtroves)).
