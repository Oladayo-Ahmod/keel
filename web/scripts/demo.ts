/**
 * Testnet demo helper: open the two demo positions, close one, move an NFT, or
 * print the wallet and positions. The key comes from ETH_PRIVATE_KEY, never from
 * the command line.
 *
 *   export ETH_PRIVATE_KEY=0x...
 *   npx tsx scripts/demo.ts status
 *   DRY_RUN=1 npx tsx scripts/demo.ts open        # sizing and hints only
 *   npx tsx scripts/demo.ts open
 *   npx tsx scripts/demo.ts close 1               # approves the vault for the MUSD it needs, then closes
 *   npx tsx scripts/demo.ts transfer 2 0xReceiver
 *
 * Optional: RPC, TARGET_ICR (default 1.6, never below 1.5 here), RESERVE (BTC kept back, default 0.015).
 */
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, formatUnits, getAddress, http, isAddress, keccak256, numberToHex, parseEventLogs, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { positionFactoryAbi, positionLensAbi, positionNFTAbi, positionVaultAbi } from "../src/abi/keel";
import { borrowerOperationsAbi, erc20Abi, priceFeedAbi } from "../src/abi/mezo";
import deployment from "../src/config/deployment.json";
import { computeHints, nicrAfterOpen } from "../src/lib/hints";
import { collForIcr } from "../src/lib/open";

const rpc = process.env.RPC ?? deployment.rpcUrl;
const chain = defineChain({
  id: deployment.chainId,
  name: deployment.name,
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const transport = http(rpc, { retryCount: 8, retryDelay: 700, timeout: 30_000 });
const pub = createPublicClient({ chain, transport });

const keel = deployment.keel as Record<string, `0x${string}`>;
const mezo = deployment.mezo as Record<string, `0x${string}`>;
const fmt = (n: bigint, d = 6) => Number(formatUnits(n, 18)).toFixed(d);

function wallet() {
  const raw = process.env.ETH_PRIVATE_KEY?.trim().replace(/^['"]|['"]$/g, "");
  if (!raw) throw new Error("ETH_PRIVATE_KEY is not set");
  const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
  return { account, client: createWalletClient({ account, chain, transport }) };
}

async function send(client: ReturnType<typeof wallet>["client"], params: Record<string, unknown>) {
  const { account } = wallet();
  const before = await pub.getTransactionCount({ address: account.address });
  try {
    const hash = await client.writeContract(params as never);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`reverted: ${hash}`);
    return receipt;
  } catch (e) {
    // a dropped connection can still have landed the transaction, so never resend blindly
    const after = await pub.getTransactionCount({ address: account.address });
    if (after !== before) console.error("the nonce moved, so the transaction may have landed. Check the wallet before retrying.");
    throw e;
  }
}

async function readPositions(holder: `0x${string}`) {
  const ids = (await pub.readContract({ address: keel.lens, abi: positionLensAbi, functionName: "positionsOf", args: [holder] })) as readonly bigint[];
  const out = [];
  for (const id of ids) {
    const info = (await pub.readContract({ address: keel.lens, abi: positionLensAbi, functionName: "positionInfo", args: [id] })) as Record<string, any>;
    out.push(info);
  }
  return out;
}

async function status() {
  const { account } = wallet();
  const musd = (await pub.readContract({ address: mezo.musd, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
  console.log("wallet", account.address);
  console.log("BTC ", fmt(await pub.getBalance({ address: account.address })));
  console.log("MUSD", fmt(musd, 2));
  for (const p of await readPositions(account.address)) {
    console.log(
      `position #${p.tokenId} vault ${p.vault} active=${p.active} coll=${fmt(p.coll)} BTC debt=${fmt(p.debt, 2)} MUSD ICR=${p.priceOk ? (Number(formatUnits(p.icr, 16))).toFixed(2) + "%" : "n/a"} rate=${p.lockedRateBps}bps`,
    );
  }
}

async function open() {
  const { account, client } = wallet();
  const target = parseUnits(process.env.TARGET_ICR ?? "1.6", 18);
  if (target < parseUnits("1.5", 18)) throw new Error("target ICR below 150%");
  const reserve = parseUnits(process.env.RESERVE ?? "0.015", 18);
  const debts = [parseUnits("1800", 18), parseUnits("1900", 18)];

  const price = (await pub.readContract({ address: mezo.priceFeed, abi: priceFeedAbi, functionName: "fetchPrice" })) as bigint;
  const balance = await pub.getBalance({ address: account.address });
  const plans = [];
  for (const debt of debts) {
    const fee = (await pub.readContract({ address: mezo.borrowerOperations, abi: borrowerOperationsAbi, functionName: "getBorrowingFee", args: [debt] })) as bigint;
    plans.push({ debt, fee, coll: collForIcr(debt, fee, price, target) });
  }
  const total = plans.reduce((a, p) => a + p.coll, 0n);
  console.log("price", fmt(price, 2), "| collateral", plans.map((p) => fmt(p.coll)).join(" + "), "BTC | balance", fmt(balance));
  if (total + reserve > balance) throw new Error("not enough BTC for both positions and the reserve");

  for (const [i, p] of plans.entries()) {
    // hints are looked up right before each send, so the second one sees the first
    const [upper, lower] = await computeHints(pub as never, nicrAfterOpen(p.coll, p.debt, p.fee));
    console.log(`position ${i + 1}: debt ${fmt(p.debt, 0)} hints ${upper} ${lower}`);
    if (process.env.DRY_RUN) continue;
    const receipt = await send(client, {
      address: keel.factory,
      abi: positionFactoryAbi,
      functionName: "openPosition",
      args: [p.debt, upper, lower, p.fee + p.fee / 20n + 1n],
      value: p.coll,
    });
    const ev = parseEventLogs({ abi: positionFactoryAbi, logs: receipt.logs, eventName: "PositionCreated" })[0];
    console.log("  tx", receipt.transactionHash, "gas", receipt.gasUsed, "id", ev?.args.tokenId, "vault", ev?.args.vault);
  }
}

async function close(idText: string) {
  const { account, client } = wallet();
  const id = BigInt(idText);
  const vault = (await pub.readContract({ address: keel.nft, abi: positionNFTAbi, functionName: "vaultOf", args: [id] })) as `0x${string}`;
  const info = (await pub.readContract({ address: keel.lens, abi: positionLensAbi, functionName: "positionInfo", args: [id] })) as Record<string, any>;
  if (info.holder.toLowerCase() !== account.address.toLowerCase()) throw new Error("this wallet does not hold that position");
  const cost = info.debt - 200n * 10n ** 18n;
  const musd = (await pub.readContract({ address: mezo.musd, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
  console.log(`closing #${id}: needs ${fmt(cost, 4)} MUSD (plus a little for interest while the tx is mined), wallet has ${fmt(musd, 2)}`);
  if (musd < cost) throw new Error("not enough MUSD");
  if (process.env.DRY_RUN) {
    // Simulate the close with the allowance faked through a state override, so nothing is sent.
    // MUSD is an OpenZeppelin ERC20 and _allowances is storage slot 1.
    const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.address, 1n]));
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [vault, inner]));
    const { result } = await pub.simulateContract({
      address: vault,
      abi: positionVaultAbi,
      functionName: "close",
      account,
      stateOverride: [{ address: mezo.musd, stateDiff: [{ slot, value: numberToHex(cost * 2n, { size: 32 }) }] }],
    });
    console.log("close simulates fine with the allowance in place", result ?? "");
    return;
  }
  // a small cushion, because interest accrues until the transaction is mined
  const allowance = cost + cost / 1000n + 1n;
  await send(client, { address: mezo.musd, abi: approveAbi, functionName: "approve", args: [vault, allowance] });
  const receipt = await send(client, { address: vault, abi: positionVaultAbi, functionName: "close", args: [] });
  console.log("closed, tx", receipt.transactionHash, "gas", receipt.gasUsed);
}

async function transfer(idText: string, to: string) {
  const { account, client } = wallet();
  if (!isAddress(to)) throw new Error("receiver is not an address");
  const id = BigInt(idText);
  const args = [account.address, getAddress(to), id] as const;
  await pub.simulateContract({ address: keel.nft, abi: positionNFTAbi, functionName: "safeTransferFrom", args, account });
  if (process.env.DRY_RUN) return console.log("transfer simulates fine");
  const receipt = await send(client, { address: keel.nft, abi: positionNFTAbi, functionName: "safeTransferFrom", args });
  console.log("transferred, tx", receipt.transactionHash, "gas", receipt.gasUsed);
}

const approveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const [cmd, a, b] = process.argv.slice(2);
const run: Record<string, () => Promise<void>> = {
  status,
  open,
  close: () => close(a),
  transfer: () => transfer(a, b),
};
if (!run[cmd]) {
  console.error("usage: demo.ts status | open | close <id> | transfer <id> <to>");
  process.exit(2);
}
run[cmd]().catch((e) => {
  console.error(String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]);
  process.exit(1);
});
