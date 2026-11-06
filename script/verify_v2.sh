#!/usr/bin/env bash
# Verify the Wave 2 testnet deployment on Sourcify (exact match needs the same compiler
# settings as foundry.toml). Read only against the chain; submits source to Sourcify.
#   script/verify_v2.sh
set -u
export PATH=$PATH:$HOME/.foundry/bin
cd "$(dirname "$0")/.." || exit 1

CHAIN=31611
FACTORY=0x70791379537cB14981AA7114678663164141eC31
NFT=0xd53f649e4df31351De8935De9cA7110888F055b8
LENS=0xCCF8c5aFe7473eC41F64906071e1bE497872004C
IMPL=0x6ef4395325828083672FFe836d6Bc80Bf22cACFE
MARKET=0xEae6fEa26B178eF32829F36e5219363bB30D93DB
FEE_RECIPIENT=0x5104C1A69242D94159Cf7151277252e568cB8F98
MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
TM=0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0

# MezoCore in struct order, see script/MatsnetCore.sol
CORE="(0xCdF7028ceAB81fA0C6971208e83fa7872994beE5,0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0,0x722E4D24FD6Ff8b0AC679450F3D91294607268fA,0xD4D6c36A592A2c5e86035A6bca1d57747a567f37,0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9,0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51,0x86bCF0841622a5dAC14A313a15f96A95421b9366,0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503)"
CORE_T="(address,address,address,address,address,address,address,address)"

# Sourcify verifies asynchronously: submitting prints a job id, the match shows up shortly after.
verify() { # address path:name args
  for _ in 1 2 3 4; do
    if forge verify-contract "$1" "$2" --verifier sourcify --chain-id $CHAIN --compiler-version 0.8.24         --num-of-optimizations 100 --evm-version london --constructor-args "$3" > /tmp/v.out 2>&1         && grep -qi "job id\|verified\|already" /tmp/v.out; then
      echo "submitted $2 $1"; return
    fi
    sleep 3
  done
  echo "could not submit $2 $1"; tail -3 /tmp/v.out
}

verify $FACTORY src/v2/TrozuFactory.sol:TrozuFactory "$(cast abi-encode "constructor($CORE_T,uint256)" "$CORE" 0)"
verify $NFT src/v2/TrozuNFT.sol:TrozuNFT "$(cast abi-encode "constructor(address)" $FACTORY)"
verify $LENS src/PositionLens.sol:PositionLens "$(cast abi-encode "constructor(address,$CORE_T)" $NFT "$CORE")"
verify $IMPL src/v2/TrozuVault.sol:TrozuVault "$(cast abi-encode "constructor(address,address,address,$CORE_T,uint256)" $FACTORY $NFT $LENS "$CORE" 0)"
verify $MARKET src/v2/TrozuMarket.sol:TrozuMarket "$(cast abi-encode "constructor(address,address,address,address,uint16)" $NFT $MUSD $TM $FEE_RECIPIENT 25)"

echo "waiting for Sourcify"; sleep 20
for a in $FACTORY $NFT $LENS $IMPL $MARKET; do
  m=$(curl -s -m 30 "https://sourcify.dev/server/v2/contract/$CHAIN/$a" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("runtimeMatch"))
except Exception: print("unknown")')
  echo "$a runtime match: $m"
done
