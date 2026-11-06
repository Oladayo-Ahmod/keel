#!/usr/bin/env tsx
// Stages two listings of the proof position for the browse view: one fixed price and one Dutch
// auction, both far above what the position is worth so nobody takes them. A listing is a
// signature plus an announce() event, so this only costs gas. Prints tx hashes, no keys.
import { hashTypedData, parseEventLogs, parseUnits, type Abi } from "viem";

import { keyFromEnv, loadAbi, loadConfig, makeClients } from "./chain.js";
import { Hex } from "./types.js";

const DAY = 86_400n;

async function main() {
  const cfg = loadConfig();
  const key = keyFromEnv("DEPLOYER_PRIVATE_KEY");
  if (!key) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
  const { publicClient: pub, walletClient: wallet, account, chain } = makeClients(cfg, key);
  const market = cfg.trozu.market as Hex;
  const nft = cfg.trozu.nft as Hex;
  const marketAbi = loadAbi(cfg, "market");
  const nftAbi = loadAbi(cfg, "nft");
  const id = BigInt(process.argv[2] ?? "1");
  const seller = account!.address;

  const read = <T>(address: Hex, abi: Abi, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  // the market must be approved to move the NFT, and a transfer away and back clears that
  const approved = await read<Hex>(nft, nftAbi, "getApproved", [id]);
  const all = await read<boolean>(nft, nftAbi, "isApprovedForAll", [seller, market]);
  if (approved.toLowerCase() !== market.toLowerCase() && !all) {
    const h = await wallet!.writeContract({ address: nft, abi: nftAbi, functionName: "approve", args: [market, id], gas: 600_000n, account: account!, chain } as never);
    await pub.waitForTransactionReceipt({ hash: h });
    console.log("approve market:", h);
  }

  const domain = { name: "TrozuMarket", version: "1", chainId: cfg.chainId, verifyingContract: market } as const;
  const types = {
    Listing: [
      { name: "seller", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "epoch", type: "uint256" },
      { name: "startPrice", type: "uint256" }, { name: "endPrice", type: "uint256" }, { name: "startTime", type: "uint64" },
      { name: "endTime", type: "uint64" }, { name: "deadline", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "salt", type: "uint256" },
    ],
  } as const;

  const ts = (await pub.getBlock()).timestamp;
  const epoch = await read<bigint>(nft, nftAbi, "transferEpoch", [id]);
  const nonce = await read<bigint>(market, marketAbi, "sellerNonce", [seller]);

  const base = { seller, tokenId: id, epoch, nonce };
  const listings = [
    { label: "fixed", l: { ...base, startPrice: parseUnits("6000", 18), endPrice: parseUnits("6000", 18), startTime: 0n, endTime: 0n, deadline: ts + 30n * DAY, salt: 7001n } },
    { label: "dutch", l: { ...base, startPrice: parseUnits("9000", 18), endPrice: parseUnits("5000", 18), startTime: ts, endTime: ts + 30n * DAY, deadline: ts + 31n * DAY, salt: 7002n } },
  ];

  const out: unknown[] = [];
  for (const { label, l } of listings) {
    const sig = await account!.signTypedData!({ domain, types, primaryType: "Listing", message: l } as never);
    const onchain = await read<Hex>(market, marketAbi, "hashListing", [l]);
    if (onchain !== hashTypedData({ domain, types, primaryType: "Listing", message: l } as never)) throw new Error("typed data hash differs from the contract's");
    await pub.simulateContract({ address: market, abi: marketAbi, functionName: "announce", args: [l, sig], account: account! } as never);
    const hash = await wallet!.writeContract({ address: market, abi: marketAbi, functionName: "announce", args: [l, sig], gas: 600_000n, account: account!, chain } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi: marketAbi, logs: r.logs, eventName: "ListingAnnounced" })[0] as unknown as { args: { hash: Hex } };
    console.log(`${label}: tx ${hash} gasUsed ${r.gasUsed} listingHash ${ev.args.hash} status ${r.status}`);
    out.push({ label, tx: hash, gasUsed: String(r.gasUsed), listingHash: ev.args.hash, listing: JSON.parse(JSON.stringify(l, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), signature: sig });
  }
  console.log(JSON.stringify(out));
}

main().catch((e) => { console.error(e instanceof Error ? e.message.split("\n")[0] : e); process.exit(1); });
