#!/usr/bin/env python3
"""Read-only snapshot of the Mezo mainnet MUSD market (chain 31612).

Everything is read at one pinned block so the numbers agree with each other.
Plain JSON-RPC over urllib, no dependencies, retries because the public RPC
drops connections and caps eth_getLogs at 10,000 blocks. Nothing here sends a
transaction or needs a key.

    python3 script/market_data.py              # scan, print, write docs/market_data.json
    BLOCK=13040764 python3 script/market_data.py
    RPC=https://... python3 script/market_data.py

Log windows are cached under script/.cache (gitignored), so a rerun at the same
or a later block only fetches what is new. Addresses come from
lib/musd/solidity/artifacts/deployments/mainnet.

The scan starts at block 0 on purpose. TroveManager and BorrowerOperations are
upgradeable proxies with several deployments, so the block of the artifact's
transaction is not a safe lower bound.
"""
import hashlib, json, os, sys, time, urllib.request, pathlib, functools, subprocess, collections
from concurrent.futures import ThreadPoolExecutor

RPC = os.environ.get("RPC", "https://rpc-http.mezo.boar.network")
ROOT = pathlib.Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "lib/musd/solidity/artifacts/deployments/mainnet"
CACHE = ROOT / "script/.cache"
STEP = 10000  # the node rejects wider ranges


def addr(name):
    return json.load(open(DEPLOY / f"{name}.json"))["address"]


TM, IR, BO = addr("TroveManager"), addr("InterestRateManager"), addr("BorrowerOperations")


def rpc(method, params, tries=8):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(RPC, body, {"content-type": "application/json", "user-agent": "trozu-market-data"})
            out = json.load(urllib.request.urlopen(req, timeout=60))
            if "error" in out:
                last = out["error"]
                time.sleep(1 + i)
                continue
            return out["result"]
        except Exception as e:
            last = e
            time.sleep(1 + i)
    raise RuntimeError(f"{method} failed: {last}")


@functools.lru_cache(maxsize=None)
def keccak(sig):
    # topics and selectors via cast, so there is no crypto dependency in this file
    c = os.path.expanduser("~/.foundry/bin/cast")
    return subprocess.check_output([c if os.path.exists(c) else "cast", "keccak", sig]).decode().strip()


def call(to, sig, args_hex="", block="latest"):
    return rpc("eth_call", [{"to": to, "data": keccak(sig)[:10] + args_hex}, block])


def words(h):
    h = h[2:]
    return [int(h[i:i + 64], 16) for i in range(0, len(h), 64)]


def pad(a):
    return a[2:].lower().rjust(64, "0")[-64:]


def scan(addresses, topics, end):
    """All logs for these addresses and topic0 set, block 0..end, 10k windows, cached."""
    CACHE.mkdir(exist_ok=True)
    key = hashlib.sha1((",".join(sorted(a.lower() for a in addresses)) + ";" + ",".join(sorted(topics))).encode()).hexdigest()[:12]
    windows = [(lo, min(lo + STEP - 1, end)) for lo in range(0, end + 1, STEP)]

    def one(w):
        full = w[1] - w[0] + 1 == STEP
        f = CACHE / f"{key}-{w[0]}.json"
        if full and f.exists():
            return json.load(open(f))
        logs = rpc("eth_getLogs", [{"address": list(addresses), "topics": [topics], "fromBlock": hex(w[0]), "toBlock": hex(w[1])}])
        if full:  # a short last window is not final, so it is never cached
            json.dump(logs, open(f, "w"))
        return logs

    with ThreadPoolExecutor(8) as ex:
        parts = list(ex.map(one, windows))
    return [l for p in parts for l in p]


def main():
    head = int(rpc("eth_blockNumber", []), 16)
    pin = int(os.environ["BLOCK"]) if os.environ.get("BLOCK") else head
    blk = hex(pin)
    ts = int(rpc("eth_getBlockByNumber", [blk, False])["timestamp"], 16)
    res = {"rpc": RPC, "chainId": int(rpc("eth_chainId", []), 16), "block": pin, "timestamp": ts,
           "addresses": {"TroveManager": TM, "InterestRateManager": IR, "BorrowerOperations": BO}}

    # state at the pinned block
    n = words(call(TM, "getTroveOwnersCount()", block=blk))[0]
    res["troveCount"] = n
    res["systemDebt"] = words(call(TM, "getEntireSystemDebt()", block=blk))[0]
    res["systemColl"] = words(call(TM, "getEntireSystemColl()", block=blk))[0]
    res["globalRateBps"] = words(call(IR, "interestRate()", block=blk))[0]
    res["proposedRateBps"] = words(call(IR, "proposedInterestRate()", block=blk))[0]
    res["proposedRateTime"] = words(call(IR, "proposedInterestRateTime()", block=blk))[0]

    troves = []
    for i in range(n):
        owner = call(TM, "getTroveFromTroveOwnersArray(uint256)", f"{i:064x}", blk)
        t = words(call(TM, "Troves(address)", pad(owner), blk))  # coll, principal, owed, stake, status, rate, ...
        e = words(call(TM, "getEntireDebtAndColl(address)", pad(owner), blk))
        troves.append({"owner": "0x" + owner[-40:], "status": t[4], "rateBps": t[5],
                       "coll": e[0], "principal": e[1], "interest": e[2]})
    res["troves"] = troves

    # cross-check the global rate by archive eth_call at spread out blocks, independent of events
    samples = {}
    for frac in (0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0):
        b = max(1, int(pin * frac))
        try:
            samples[b] = words(call(IR, "interestRate()", block=hex(b)))[0]
        except Exception as e:
            samples[b] = f"unavailable ({str(e)[:40]})"
    res["globalRateAtBlocks"] = samples

    # one pass for every event of interest
    t = {k: keccak(v) for k, v in {
        "proposed": "InterestRateProposed(uint16,uint256)",
        "updated": "InterestRateUpdated(uint16)",
        "redemption": "Redemption(uint256,uint256,uint256,uint256)",
        "liquidation": "Liquidation(uint256,uint256,uint256,uint256,uint256)",
        "troveLiquidated": "TroveLiquidated(address,uint256,uint256,uint8)",
        "troveUpdated": "TroveUpdated(address,uint256,uint256,uint256,uint256,uint16,uint256,uint8)",
        "troveCreated": "TroveCreated(address,uint256)",
    }.items()}
    logs = scan([TM, IR, BO], list(t.values()), pin)
    lc = lambda a: a.lower()
    ir = [l for l in logs if lc(l["address"]) == lc(IR)]
    tm = [l for l in logs if lc(l["address"]) == lc(TM)]
    bo = [l for l in logs if lc(l["address"]) == lc(BO)]
    res["firstEventBlock"] = min(int(l["blockNumber"], 16) for l in logs) if logs else None

    res["rateEvents"] = [{"block": int(l["blockNumber"], 16), "tx": l["transactionHash"],
                          "kind": "proposed" if l["topics"][0] == t["proposed"] else "updated",
                          "rateBps": words(l["data"])[0]} for l in ir]

    # redemptions: troves hit = distinct TroveUpdated(op 2) in the same tx, from TroveManager
    hit = collections.defaultdict(set)
    for l in tm:
        if l["topics"][0] == t["troveUpdated"] and words(l["data"])[-1] == 2:
            hit[l["transactionHash"]].add(l["topics"][1])
    reds = [l for l in tm if l["topics"][0] == t["redemption"]]
    res["redemptions"] = [{"block": int(l["blockNumber"], 16), "tx": l["transactionHash"],
                           "attempted": words(l["data"])[0], "actual": words(l["data"])[1],
                           "trovesHit": len(hit.get(l["transactionHash"], ()))} for l in reds]
    liqs = [l for l in tm if l["topics"][0] == t["liquidation"]]
    res["liquidations"] = [{"block": int(l["blockNumber"], 16), "tx": l["transactionHash"],
                            "principal": words(l["data"])[0], "interest": words(l["data"])[1],
                            "coll": words(l["data"])[2]} for l in liqs]
    res["troveLiquidatedEvents"] = sum(1 for l in tm if l["topics"][0] == t["troveLiquidated"])

    # locked rate at every open, from BorrowerOperations TroveUpdated with operation 0.
    # data words: principal, interest, coll, stake, rate, lastUpdate, operation
    opens, refis = [], []
    for l in bo:
        if l["topics"][0] != t["troveUpdated"]:
            continue
        w = words(l["data"])
        row = {"block": int(l["blockNumber"], 16), "tx": l["transactionHash"], "rateBps": w[4], "principal": w[0]}
        (opens if w[6] == 0 else refis if w[6] == 3 else []).append(row)
    res["opens"] = opens
    res["refinances"] = refis
    res["opensByRateBps"] = dict(collections.Counter(o["rateBps"] for o in opens))
    res["refinancesByRateBps"] = dict(collections.Counter(o["rateBps"] for o in refis))

    (ROOT / "docs/market_data.json").write_text(json.dumps(res, indent=2) + "\n")
    report(res)


def e18(x):
    return f"{x / 1e18:,.4f}"


def report(r):
    print(f"block {r['block']} (unix {r['timestamp']}), chain {r['chainId']}, first event block {r['firstEventBlock']}")
    print(f"troves {r['troveCount']}, system debt {e18(r['systemDebt'])} MUSD, system coll {e18(r['systemColl'])} BTC")
    print(f"global rate {r['globalRateBps']} bps, proposed {r['proposedRateBps']} bps (proposal time {r['proposedRateTime']})")
    for x in r["troves"]:
        print(f"  {x['owner']} status {x['status']} locked {x['rateBps']} bps coll {e18(x['coll'])} debt {e18(x['principal'] + x['interest'])}")
    print("global rate at blocks:", r["globalRateAtBlocks"])
    print("rate events:", [(e["block"], e["kind"], e["rateBps"]) for e in r["rateEvents"]])
    print(f"redemptions {len(r['redemptions'])}, MUSD {e18(sum(x['actual'] for x in r['redemptions']))}, troves hit {sum(x['trovesHit'] for x in r['redemptions'])}")
    print(f"liquidation events {len(r['liquidations'])}, TroveLiquidated {r['troveLiquidatedEvents']}")
    print("opens:", len(r["opens"]), "by locked rate:", r["opensByRateBps"])
    print("refinances:", len(r["refinances"]), "by new rate:", r["refinancesByRateBps"])


if __name__ == "__main__":
    main()
