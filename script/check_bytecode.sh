#!/usr/bin/env bash
# Compares the creation input of the deployed factory and lens with what this
# checkout compiles to. A match means the deployed code is this source, even when
# the explorer cannot verify it. Read only.
#   script/check_bytecode.sh <factory_tx_hash> <lens_tx_hash> <nft_address>
set -euo pipefail

RPC=${RPC:-https://rpc.test.mezo.org}
FACTORY_TX=${1:?factory deploy tx hash}
LENS_TX=${2:?lens deploy tx hash}
NFT=${3:?nft address}
CORE='(0xCdF7028ceAB81fA0C6971208e83fa7872994beE5,0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0,0x722E4D24FD6Ff8b0AC679450F3D91294607268fA,0xD4D6c36A592A2c5e86035A6bca1d57747a567f37,0xB4C35747c26E4aB5F1a7CdC7E875B5946eFa6fa9,0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51,0x86bCF0841622a5dAC14A313a15f96A95421b9366,0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503)'
TUPLE='(address,address,address,address,address,address,address,address)'

input_of() {
  for _ in $(seq 1 25); do
    out=$(cast tx "$1" input --rpc-url "$RPC" 2>/dev/null) && [ -n "$out" ] && { echo "$out"; return; }
    sleep 1
  done
  echo "could not read $1" >&2
  exit 1
}

check() {
  local name=$1 tx=$2 args=$3
  local expected actual
  expected="$(forge inspect "$name" bytecode)${args#0x}"
  actual=$(input_of "$tx")
  if [ "$expected" = "$actual" ]; then
    echo "$name: deployed creation input matches this checkout"
  else
    echo "$name: MISMATCH" >&2
    exit 1
  fi
}

check PositionFactory "$FACTORY_TX" "$(cast abi-encode "constructor($TUPLE)" "$CORE")"
check PositionLens "$LENS_TX" "$(cast abi-encode "constructor(address,$TUPLE)" "$NFT" "$CORE")"
