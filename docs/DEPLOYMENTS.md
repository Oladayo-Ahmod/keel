# Deployments

## Mezo testnet (matsnet, chain id 31611)

Status: **not deployed yet.** The scripts are ready and dry-run against the live chain. Addresses go in the table below after the broadcast.

| Contract | Address | Verified |
|---|---|---|
| PositionFactory | | |
| PositionNFT (created by the factory) | | |
| PositionVault implementation (created by the factory) | | |
| PositionLens | | |

Deployer wallet: _to fill in_. Block: _to fill in_.

KEEL is bound to these Mezo contracts (see [VERIFICATION.md](VERIFICATION.md)): BorrowerOperations `0xCdF7028ceAB81fA0C6971208e83fa7872994beE5`, TroveManager `0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0`, SortedTroves `0x722E4D24FD6Ff8b0AC679450F3D91294607268fA`, InterestRateManager `0xD4D6c36A592A2c5e86035A6bca1d57747a567f37`, CollSurplusPool `0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9`, ActivePool `0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51`, PriceFeed `0x86bCF0841622a5dAC14A313a15f96A95421b9366`, MUSD `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`.

## Reproduce

The deployer key is read from the environment and is never written to a file in the repository.

```
export DEPLOYER_PRIVATE_KEY=0x...
forge script script/Deploy.s.sol --rpc-url https://rpc.test.mezo.org --broadcast --skip-simulation
```

`--skip-simulation` is needed because the Mezo price feed calls a chain precompile that forge cannot simulate. A dry run without `--broadcast` and without `--skip-simulation` works for the deploy script, since it never touches the price feed. A dry run on 2026-10-21 estimated 6.9M gas in total, under the 10M block gas limit, at a cost far below 0.001 BTC.

The public RPC drops some connections. If a broadcast fails with a TLS error, run it again; check the nonce first with `cast nonce <deployer> --rpc-url https://rpc.test.mezo.org`.

## Verify

The explorer is Blockscout. The factory creates the NFT and the vault implementation in its constructor, so those two are verified separately.

```
forge verify-contract <factory> src/PositionFactory.sol:PositionFactory \
  --verifier blockscout --verifier-url https://api.explorer.test.mezo.org/api \
  --chain-id 31611 --constructor-args $(cast abi-encode "constructor((address,address,address,address,address,address,address,address))" "(<core tuple>)")
```

Use the same pattern for `PositionLens`, `PositionNFT` (constructor argument: the factory address) and `PositionVault` (factory, NFT, core tuple). The core tuple order is the field order of `MezoCore` in `src/MezoCore.sol`. Mark each row verified only after the explorer shows it.

## Testnet budget

The faucet gave 0.099 BTC. Plan, at a target ICR of 160% (never below 150%) and an oracle price of about 84,127 USD:

| Item | BTC |
|---|---|
| Position 1: 1,800 MUSD debt | 0.0381 |
| Position 2: 1,900 MUSD debt | 0.0400 |
| Reserve for gas and a second demo wallet | at least 0.015 |
| Left over | about 0.006 |

Position 2 borrows 100 MUSD more than the minimum on purpose. After both opens the wallet holds 3,700 MUSD. Closing position 1 needs `debt - 200`, about 1,802 MUSD plus a little interest, so the extra MUSD from position 2 covers it. The 160% target leaves a 10% margin over the 150% floor against oracle moves.

```
export FACTORY=0x...
export BTC_PRICE_E18=$(cast call 0x86bCF0841622a5dAC14A313a15f96A95421b9366 'fetchPrice()(uint256)' --rpc-url https://rpc.test.mezo.org | cut -d' ' -f1)
forge script script/OpenDemo.s.sol --rpc-url https://rpc.test.mezo.org --broadcast --skip-simulation
```

The script refuses to run if the target ICR is under 150% or if the two positions plus the reserve do not fit in the wallet balance. It computes sorted-list hints on chain right before sending; a stale hint would only cost gas (see [VERIFICATION.md](VERIFICATION.md#stale-hints-in-sortedtroves)).
