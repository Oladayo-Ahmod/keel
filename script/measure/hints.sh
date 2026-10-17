#!/usr/bin/env bash
# Gas of a matsnet openTrove under good and bad sorted-list hints, simulated
# with eth_estimateGas from a funded address that has no trove. Read only.
#   script/measure/hints.sh
set -u
RPC=${RPC:-https://rpc.test.mezo.org}
BO=0xCdF7028ceAB81fA0C6971208e83fa7872994beE5
ST=0x722E4D24FD6Ff8b0AC679450F3D91294607268fA
HH=0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6
FROM=0x143A063F62340DA3A8bEA1C5642d18C6D0F7FF51
COLL=36000000000000000
DEBT=1800000000000000000000
ZERO=0x0000000000000000000000000000000000000000
JUNK=0x000000000000000000000000000000000000dEaD

# the public RPC drops some connections, so retry
retry() {
  local out
  for _ in 1 2 3 4 5 6; do
    out=$("$@" 2>&1) && { echo "$out"; return; }
    sleep 1
  done
  echo "FAIL: $out" | head -1
}

nicr=$(python3 -c "print($COLL * 10**20 // (($DEBT * 1001 // 1000) + 200 * 10**18))")
first=$(retry cast call $ST 'getFirst()(address)' --rpc-url "$RPC")
last=$(retry cast call $ST 'getLast()(address)' --rpc-url "$RPC")
approx=$(retry cast call $HH 'getApproxHint(uint256,uint256,uint256)(address,uint256,uint256)' "$nicr" 50 42 --rpc-url "$RPC" | head -1)
pos=$(retry cast call $ST 'findInsertPosition(uint256,address,address)(address,address)' "$nicr" "$approx" "$approx" --rpc-url "$RPC")
prev=$(echo "$pos" | sed -n 1p)
next=$(echo "$pos" | sed -n 2p)
echo "size $(retry cast call $ST 'getSize()(uint256)' --rpc-url "$RPC"), nicr $nicr"

estimate() {
  printf '%-28s' "$1"
  retry cast estimate $BO 'openTrove(uint256,address,address)' $DEBT "$2" "$3" --from $FROM --value $COLL --rpc-url "$RPC"
}
estimate "correct hints" "$prev" "$next"
estimate "no hints" $ZERO $ZERO
estimate "non-member address" $JUNK $JUNK
estimate "neighbours swapped" "$next" "$prev"
estimate "head as both hints" "$first" "$first"
estimate "tail as both hints" "$last" "$last"
estimate "previous only" "$prev" $ZERO
estimate "next only" $ZERO "$next"
