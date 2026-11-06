#!/usr/bin/env tsx
// Trozu keeper. One pass: find vaults that have a guardian policy, ask each vault's own planner
// whether execute() would act, and send it where it would.
//
//   KEEPER_PRIVATE_KEY=0x... npm run keeper            # sends
//   npm run keeper -- --dry-run                         # reads and estimates, sends nothing
//
// Environment: KEEPER_PRIVATE_KEY (required unless --dry-run), RPC_URL (optional override),
// FROM_BLOCK (optional, defaults to the factory's deployment block), DRY_RUN=1 (same as the flag).
// The key is read from the environment only and is never printed.
import { keyFromEnv, loadConfig, makeClients, realChain } from "./chain.js";
import { runOnce } from "./keeper.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || process.env.DRY_RUN === "1";
  const cfgPath = args.find((a) => a.startsWith("--config="))?.slice(9);
  const cfg = loadConfig(cfgPath);
  const key = keyFromEnv("KEEPER_PRIVATE_KEY");
  if (!key && !dryRun) {
    console.error("KEEPER_PRIVATE_KEY is not set. Use --dry-run to read without sending.");
    process.exit(2);
  }
  const { publicClient, walletClient, account } = makeClients(cfg, key, process.env.RPC_URL || undefined);
  const chain = realChain(cfg, publicClient, walletClient);
  const fromBlock = BigInt(process.env.FROM_BLOCK || cfg.deployedAtBlock);

  console.log(`trozu keeper, chain ${cfg.chainId}, ${dryRun ? "DRY RUN" : "live"}, keeper ${account?.address ?? "(none)"}`);
  const outcomes = await runOnce(chain, { fromBlock, dryRun, log: (l) => console.log(l) });

  for (const o of outcomes) {
    const extra = o.result === "sent" ? ` tx ${o.tx} gas ${o.gasUsed}` : o.result === "failed" ? ` ${o.why}` : o.result === "skipped" ? ` ${o.why}` : "";
    console.log(`${o.vault} ${o.result}${"kind" in o ? ` ${o.kind} amount=${o.amount} tip=${o.tip}` : ""}${extra}`);
  }
  console.log(`${outcomes.length} vault(s): ${outcomes.filter((o) => o.result === "sent").length} sent, ${outcomes.filter((o) => o.result === "would-send").length} would send, ${outcomes.filter((o) => o.result === "failed").length} failed`);
  process.exit(outcomes.some((o) => o.result === "failed") ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
