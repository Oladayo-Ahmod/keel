#!/usr/bin/env bash
# Reads the EIP-1967 implementation and admin slots of the matsnet core
# contracts, and the owner of each ProxyAdmin. Read only.
#   script/measure/proxy_slots.sh
set -u
RPC=${RPC:-https://rpc.test.mezo.org}
IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
ADMIN_SLOT=0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103

slot() {
  local out
  for _ in $(seq 1 12); do
    out=$(cast storage "$1" "$2" --rpc-url "$RPC" 2>/dev/null)
    [ ${#out} -eq 66 ] && { echo "0x${out: -40}"; return; }
    sleep 1
  done
  echo FAIL
}

owner() {
  local out
  for _ in $(seq 1 12); do
    out=$(cast call "$1" 'owner()(address)' --rpc-url "$RPC" 2>/dev/null) && [ -n "$out" ] && { echo "$out"; return; }
    sleep 1
  done
  echo FAIL
}

while read -r name addr; do
  impl=$(slot "$addr" $IMPL_SLOT)
  admin=$(slot "$addr" $ADMIN_SLOT)
  printf '%-30s impl=%s admin=%s admin_owner=%s\n' "$name" "$impl" "$admin" "$(owner "$admin")"
done <<'LIST'
ActivePool 0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51
BorrowerOperations 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5
BorrowerOperationsSignatures 0xD757e3646AF370b15f32EB557F0F8380Df7D639e
CollSurplusPool 0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9
DefaultPool 0x59851D252090283f9367c159f0C9036e75483300
GasPool 0x8fa3EF45137C3AFF337e42f98023C1D7dd3666C0
GovernableVariables 0x6552059B6eFc6aA4AE3ea45f28ED4D92acE020cD
HintHelpers 0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6
InterestRateManager 0xD4D6c36A592A2c5e86035A6bca1d57747a567f37
MUSD 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
PCV 0x4dDD70f4C603b6089c07875Be02fEdFD626b80Af
PriceFeed 0x86bCF0841622a5dAC14A313a15f96A95421b9366
SortedTroves 0x722E4D24FD6Ff8b0AC679450F3D91294607268fA
StabilityPool 0x1CCA7E410eE41739792eA0A24e00349Dd247680e
TroveManager 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0
LIST
