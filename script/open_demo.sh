#!/usr/bin/env bash
# Opens the two testnet demo positions from one wallet. The second borrows a bit
# more, so its MUSD covers closing the first. Sizing comes from DemoPlan.plan, so
# it refuses to go under 150% ICR or over the wallet budget.
#
#   export DEPLOYER_PRIVATE_KEY=0x...   # or source it from a gitignored .env
#   export FACTORY=0x...
#   script/open_demo.sh            # DRY_RUN=1 prints the plan and hints only
#
# The key is passed to cast on the command line, so it is visible in `ps` on this
# machine while a transaction is being sent. Use a keystore on shared machines.
set -euo pipefail

RPC=${RPC:-https://rpc.test.mezo.org}
PRICE_FEED=0x86bCF0841622a5dAC14A313a15f96A95421b9366
HINT_HELPERS=0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6
SORTED_TROVES=0x722E4D24FD6Ff8b0AC679450F3D91294607268fA
TROVE_MANAGER=0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0
: "${DEPLOYER_PRIVATE_KEY:?not set}"
: "${FACTORY:?not set}"
KEY=$DEPLOYER_PRIVATE_KEY
case "$KEY" in 0x*) ;; *) KEY="0x$KEY" ;; esac
TARGET_ICR=${TARGET_ICR_E18:-1600000000000000000}
RESERVE=${RESERVE:-15000000000000000}
DEBTS=(1800000000000000000000 1900000000000000000000)

# the public RPC drops some connections, so reads are retried
retry() {
  local out
  for _ in $(seq 1 25); do
    out=$("$@" 2>&1) && { echo "$out"; return 0; }
    sleep 1
  done
  echo "$out" >&2
  return 1
}

wallet=$(cast wallet address --private-key "$KEY")
balance=$(retry cast balance "$wallet" --rpc-url "$RPC")
price=$(retry cast call $PRICE_FEED 'fetchPrice()(uint256)' --rpc-url "$RPC" | cut -d' ' -f1)
echo "wallet $wallet"
echo "balance $balance wei, price $price"

# sizing mirrors DemoPlan.plan, which has the tests: composite debt is the debt plus
# the 0.1% fee plus the 200 MUSD reserve, collateral is rounded up to the target ICR
sizing='
import sys
price, icr, balance, reserve, d1, d2 = map(int, sys.argv[1:])
if price <= 0:
    sys.exit("no price")
if icr < 15 * 10**17:
    sys.exit("target ICR below 150%")
out = []
for d in (d1, d2):
    comp = d + d * 10 // 10_000 + 200 * 10**18
    out.append((comp * icr + price - 1) // price)
if sum(out) + reserve > balance:
    sys.exit("not enough BTC for both positions and the reserve")
print(*out)
'
colls=($(python3 -c "$sizing" "$price" "$TARGET_ICR" "$balance" "$RESERVE" "${DEBTS[@]}"))
echo "collateral: ${colls[0]} and ${colls[1]} wei"

nonce() { retry cast nonce "$wallet" --rpc-url "$RPC"; }

for i in 0 1; do
  debt=${DEBTS[$i]}
  coll=${colls[$i]}
  # NICR after the open: coll * 1e20 / (debt + 0.1% fee + 200 MUSD reserve)
  nicr=$(python3 -c "print($coll * 10**20 // ($debt + $debt // 1000 + 200 * 10**18))")
  approx=$(retry cast call $HINT_HELPERS 'getApproxHint(uint256,uint256,uint256)(address,uint256,uint256)' "$nicr" 50 42 --rpc-url "$RPC" | head -1)
  pos=$(retry cast call $SORTED_TROVES 'findInsertPosition(uint256,address,address)(address,address)' "$nicr" "$approx" "$approx" --rpc-url "$RPC")
  upper=$(echo "$pos" | sed -n 1p)
  lower=$(echo "$pos" | sed -n 2p)

  echo "position $((i + 1)): debt $debt, hints $upper $lower"
  if [ -n "${DRY_RUN:-}" ]; then continue; fi

  # bash integers are 64 bit, so wei amounts go through python
  max_fee=$(python3 -c "print($debt // 100)")

  # A dropped connection can happen before or after the node accepts the
  # transaction, so retry only while the nonce has not moved.
  before=$(nonce)
  sent=
  for attempt in 1 2 3 4 5 6 7 8; do
    if out=$(cast send "$FACTORY" 'openPosition(uint256,address,address,uint256)' "$debt" "$upper" "$lower" "$max_fee" \
        --value "$coll" --private-key "$KEY" --rpc-url "$RPC" --json 2>&1); then
      sent=1
      break
    fi
    sleep 3
    if [ "$(nonce)" != "$before" ]; then
      echo "the send may have landed (nonce moved), check the wallet before retrying" >&2
      echo "$out" >&2
      exit 1
    fi
  done
  if [ -z "$sent" ]; then
    echo "$out" >&2
    exit 1
  fi
  python3 - "$out" "$FACTORY" <<'P'
import json, sys
r = json.loads(sys.argv[1])
# PositionCreated comes from the factory; the NFT's Transfer event also has four topics
created = [l for l in r["logs"] if l["address"].lower() == sys.argv[2].lower() and len(l["topics"]) == 4]
t = created[-1]["topics"]
print("tx", r["transactionHash"], "status", r["status"], "gas", int(r["gasUsed"], 16))
print("position id", int(t[1], 16), "vault", "0x" + t[2][-40:], "holder", "0x" + t[3][-40:])
P
done
