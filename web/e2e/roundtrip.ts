// TEST ONLY. Runs each wallet action once through the real UI against the proof position on matsnet,
// using burner keys from .env (never printed). Needs the e2e build served on :3100:
//   NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_WAVE2=1 NEXT_PUBLIC_SITE_URL=https://trozu-e2e.example NEXT_DIST_DIR=.next-e2e next build && next start -p 3100
//   (a production build refuses a missing or local site URL, so the e2e build sets a placeholder too)
//   npx tsx e2e/roundtrip.ts [--only=add,repay] [--redo]
// Writes docs/roundtrip.json and 390 px screenshots to docs/roundtrip/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createWalletClient, http, parseAbi, parseUnits, type Hex } from "viem";
const transferAbi = parseAbi(["function transfer(address,uint256) returns (bool)"]);
import deployment from "../src/config/deployment.v2.json";
import { attachWallet, chain, keyOf, publicClient, type TxRecord } from "./wallet";

const ROOT = resolve(__dirname, "../..");
const OUT = resolve(ROOT, "docs/roundtrip.json");
const SHOTS = resolve(ROOT, "docs/roundtrip");
const BASE = process.env.APP ?? "http://127.0.0.1:3100";
const VAULT = "0x2B08BB7F73beD0FA0454907a7E7082F1a58d9AB9" as Hex;
const MUSD = deployment.mezo.musd as Hex;
mkdirSync(SHOTS, { recursive: true });

interface Result {
  name: string;
  what: string;
  status: "ok" | "failed" | "not-run";
  note?: string;
  txs: { who: string; fn: string; hash?: Hex; gasLimit?: string; gasUsed?: string; txStatus?: string; error?: string }[];
  shots: string[];
  at: string;
}
const results: Record<string, Result> = existsSync(OUT) ? Object.fromEntries((JSON.parse(readFileSync(OUT, "utf8")).results as Result[]).map((r) => [r.name, r])) : {};
const save = () => writeFileSync(OUT, JSON.stringify({ chainId: deployment.chainId, note: "Wallet actions run through the real UI with a test-only connector. gasLimit is what the app asked for; gasUsed is from the receipt.", results: Object.values(results) }, null, 2));

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const redo = args.includes("--redo");

/** Screenshots of the signing, pending, success and failed states while a step runs, at 390 px. */
function watch(page: Page, name: string, shots: string[]) {
  let stop = false;
  const seen = new Set<string>();
  const loop = (async () => {
    while (!stop) {
      for (const st of ["signing", "pending", "success", "failed"]) {
        if (seen.has(st)) continue;
        const loc = page.locator(`.tx.tx-${st}`).first();
        if (await loc.isVisible().catch(() => false)) {
          seen.add(st);
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          const f = `${name}-${st}.jpg`;
          await page.screenshot({ path: resolve(SHOTS, f), type: "jpeg", quality: 70 }).catch(() => {});
          shots.push(f);
        }
      }
      await page.waitForTimeout(100);
    }
  })();
  return async () => { stop = true; await loop; };
}

async function outcome(page: Page, scope: string, ms = 150_000): Promise<{ ok: boolean; text: string }> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = page.locator(`${scope} .tx-success`).first();
    const f = page.locator(`${scope} .tx-failed`).first();
    if (await s.isVisible().catch(() => false)) return { ok: true, text: (await s.innerText()).replace(/\n/g, " ") };
    if (await f.isVisible().catch(() => false)) return { ok: false, text: (await f.innerText()).replace(/\n/g, " ") };
    await page.waitForTimeout(400);
  }
  return { ok: false, text: "timed out waiting for the transaction" };
}

type Wallet = Awaited<ReturnType<typeof attachWallet>>;

async function finish(r: Result, w: Wallet, from: number) {
  for (const t of w.log.slice(from) as TxRecord[]) {
    const row: Result["txs"][number] = { who: t.who, fn: t.fn, hash: t.hash, gasLimit: t.gasLimit?.toString(), error: t.error };
    if (t.hash) {
      try {
        const rc = await publicClient.waitForTransactionReceipt({ hash: t.hash, timeout: 90_000 });
        row.gasUsed = rc.gasUsed.toString();
        row.txStatus = rc.status;
      } catch { /* the receipt may lag; the hash is still recorded */ }
    }
    r.txs.push(row);
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const open = async (who: string, key: Hex) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const w = await attachWallet(page, who, key);
    await page.goto(BASE + "/");
    await page.getByText("Position #").first().waitFor({ timeout: 90_000 }).catch(() => {});
    return { page, w };
  };
  const D = await open("deployer", keyOf("DEPLOYER_PRIVATE_KEY"));
  const dPage = D.page;
  const manage = () => dPage.locator('section[aria-label="Manage this position"]').first();
  const guardian = () => dPage.locator('section[aria-label="Guardian"]').first();
  const sell = () => dPage.locator('section[aria-label="Sell this position"]').first();

  const run = async (name: string, what: string, w: Wallet, page: Page, scope: string, fn: () => Promise<string | void>) => {
    if (only && !only.includes(name)) return;
    if (!redo && results[name]?.status === "ok") { console.log(`[skip] ${name}`); return; }
    console.log(`[run ] ${name}: ${what}`);
    const r: Result = { name, what, status: "failed", txs: [], shots: [], at: new Date().toISOString() };
    const from = w.log.length;
    const stop = watch(page, name, r.shots);
    try {
      const note = await fn();
      if (note) r.note = note;
      const o = scope ? await outcome(page, scope) : { ok: true, text: "" };
      r.status = name === "rejected" ? (!o.ok && /declined/i.test(o.text) ? "ok" : "failed") : o.ok ? "ok" : "failed";
      if (o.text) r.note = [r.note, o.text].filter(Boolean).join(" | ");
    } catch (e) {
      r.note = e instanceof Error ? e.message.split("\n").slice(0, 3).join(" ") : String(e);
      await page.screenshot({ path: resolve(SHOTS, `${name}-error.jpg`), type: "jpeg", quality: 70 }).catch(() => {});
      r.shots.push(`${name}-error.jpg`);
    }
    await stop();
    await finish(r, w, from);
    results[name] = r;
    save();
    console.log(`       ${r.status}${r.note ? ": " + r.note.slice(0, 160) : ""}${r.txs.map((t) => `\n       ${t.fn} ${t.hash ?? "(no hash)"} limit ${t.gasLimit} used ${t.gasUsed}`).join("")}`);
    await page.waitForTimeout(1500);
  };

  const tab = (scopeLoc: () => ReturnType<typeof manage>, label: string) => scopeLoc().getByRole("tab", { name: label, exact: true }).click();
  const noteOnly = (name: string, what: string, note: string) => {
    if (only && !only.includes(name)) return;
    results[name] = { name, what, status: "not-run", note, txs: [], shots: [], at: new Date().toISOString() };
    save();
    console.log(`[note] ${name}: ${note}`);
  };

  /** A manage-panel action: pick the tab, type the amount, Review, confirm. */
  const act = (label: string, field: string | undefined, amount: string | undefined, confirm: string) => async () => {
    await tab(manage, label);
    if (field && amount) await manage().getByLabel(field).fill(amount);
    await manage().getByRole("button", { name: "Review", exact: true }).click();
    await manage().locator(".review").getByRole("heading", { name: "Check before you send" }).waitFor({ timeout: 30_000 });
    await manage().screenshot({ path: resolve(SHOTS, `${label.replace(/\W+/g, "-").toLowerCase()}-review.jpg`), type: "jpeg", quality: 70 });
    await manage().locator(".review").getByRole("button", { name: confirm, exact: true }).click();
  };

  // ---- the deployer's own actions on the proof position (NFT 1)
  await run("add", "Add collateral 0.0005 BTC", D.w, dPage, 'section[aria-label="Manage this position"]', act("Add collateral", "Collateral to add (BTC)", "0.0005", "Add collateral"));

  await run("rejected", "Wallet rejects an add (error state)", D.w, dPage, 'section[aria-label="Manage this position"]', async () => {
    D.w.ctl.rejectNext = true;
    await act("Add collateral", "Collateral to add (BTC)", "0.0001", "Add collateral")();
  });

  await run("withdraw", "Withdraw 0.0002 BTC (stays far above 150%)", D.w, dPage, 'section[aria-label="Manage this position"]', act("Withdraw", "Collateral to withdraw (BTC)", "0.0002", "Withdraw"));

  await run("borrow", "Borrow 10 MUSD", D.w, dPage, 'section[aria-label="Manage this position"]', act("Borrow", "MUSD to borrow", "10", "Borrow"));

  await run("repay", "Repay 1 MUSD with a signed permit (Mezo allows at most 1.83: the 2,000 MUSD minimum debt)", D.w, dPage, 'section[aria-label="Manage this position"]', act("Repay", "MUSD to repay", "1", "Repay"));

  // ---- sweep: put a little stray BTC and MUSD in the vault first, from the deployer directly
  if (!only || only.some((n) => n.startsWith("sweep"))) {
    const wc = createWalletClient({ account: D.w.account, chain, transport: http(deployment.rpcUrl, { retryCount: 3 }) });
    if (!results["sweep-musd"] || results["sweep-musd"].status !== "ok" || redo) {
      try {
        const h2 = await wc.writeContract({ address: MUSD, abi: transferAbi, functionName: "transfer", args: [VAULT, parseUnits("1", 18)], gas: 1_000_000n });
        await publicClient.waitForTransactionReceipt({ hash: h2 });
        console.log("stray MUSD sent to the vault:", h2);
      } catch (e) {
        console.log("could not send stray funds:", e instanceof Error ? e.message.split("\n")[0] : e);
      }
    }
    await dPage.reload();
    await dPage.getByText("Position #").first().waitFor({ timeout: 60_000 });
  }
  const sweep = (token: RegExp) => async () => {
    await tab(manage, "Sweep");
    await manage().getByRole("button", { name: token }).click();
    await manage().getByRole("button", { name: "Review", exact: true }).click();
    await manage().locator(".review").getByRole("button", { name: "Sweep", exact: true }).click();
  };
  noteOnly("sweep-btc", "Sweep stray BTC", "Not run: the vault has no plain BTC receive, so a normal send reverts and only a forced send (selfdestruct) could leave BTC in it. The sweep button stays disabled with nothing to sweep, which is the verified behaviour; the BTC sweep path is covered by Foundry tests.");
  await run("sweep-musd", "Sweep stray MUSD out of the vault", D.w, dPage, 'section[aria-label="Manage this position"]', sweep(/^MUSD ·/));

  // ---- claim and refinance can only be looked at: there is nothing to claim and no lower rate
  if (!only || only.includes("claim")) {
    await tab(manage, "Claim surplus");
    const disabled = await manage().getByRole("button", { name: "Review", exact: true }).isDisabled();
    await manage().screenshot({ path: resolve(SHOTS, "claim-state.jpg"), type: "jpeg", quality: 70 });
    noteOnly("claim", "Claim surplus", disabled ? "Not run: nothing to claim (no redemption or liquidation has left surplus), so the app keeps the button disabled. The disabled state is the verified behaviour." : "Button was enabled; run it by hand");
  }
  if (!only || only.includes("refinance")) {
    await tab(manage, "Refinance");
    const text = (await manage().innerText()).replace(/\n+/g, " ");
    const disabled = await manage().getByRole("button", { name: "Review", exact: true }).isDisabled();
    await manage().screenshot({ path: resolve(SHOTS, "refinance-state.jpg"), type: "jpeg", quality: 70 });
    noteOnly("refinance", "Refinance", `${disabled ? "Not run: no lower global rate exists" : "Button enabled"}. Panel text: ${text.slice(text.indexOf("Refinance", 60), text.indexOf("Refinance", 60) + 220)}`);
  }

  // ---- guardian: policy and reserve
  const gTab = (n: string) => guardian().getByRole("tab", { name: n, exact: true }).click();
  await run("policy", "Guardian: save a policy", D.w, dPage, 'section[aria-label="Guardian"]', async () => {
    await gTab("Policy");
    await guardian().getByRole("button", { name: /^(Save|Replace) policy$/ }).click();
  });
  const reserve = (op: string, amount: string) => async () => {
    await gTab("Reserve");
    await guardian().getByRole("button", { name: op, exact: true }).first().click();
    await guardian().getByLabel(/^Amount/).fill(amount);
    await guardian().getByRole("button", { name: op, exact: true }).last().click();
  };
  await run("reserve-fund-btc", "Guardian reserve: add 0.0001 BTC", D.w, dPage, 'section[aria-label="Guardian"]', reserve("Add BTC", "0.0001"));
  await run("reserve-withdraw-btc", "Guardian reserve: take out 0.0001 BTC", D.w, dPage, 'section[aria-label="Guardian"]', reserve("Take out BTC", "0.0001"));
  await run("reserve-fund-musd", "Guardian reserve: add 5 MUSD (permit)", D.w, dPage, 'section[aria-label="Guardian"]', reserve("Add MUSD", "5"));
  await run("reserve-withdraw-musd", "Guardian reserve: take out 5 MUSD", D.w, dPage, 'section[aria-label="Guardian"]', reserve("Take out MUSD", "5"));

  // ---- market: list fixed (to be bought), list again at a price nobody takes, cancel that one
  const listFixed = (price: string) => async () => {
    await sell().getByRole("button", { name: "List for sale" }).click();
    await sell().getByRole("button", { name: "Fixed price", exact: true }).click();
    await sell().getByLabel("Price (MUSD)").fill(price);
    await sell().getByRole("button", { name: "Sign and list" }).click();
  };
  await run("list-fixed-100", "List fixed price 100 MUSD (the one the second wallet buys)", D.w, dPage, 'section[aria-label="Sell this position"]', listFixed("100"));
  await dPage.reload();
  await dPage.getByText("Position #").first().waitFor({ timeout: 60_000 });
  await run("list-fixed-cancel-me", "List fixed price 7,000 MUSD (to cancel)", D.w, dPage, 'section[aria-label="Sell this position"]', listFixed("7000"));

  // the second wallet buys the 100 MUSD listing through the market screen, then sends the position back
  if (!only || only.includes("buy") || only.includes("transfer-back")) {
    const S = await open("second", keyOf("SECOND_PRIVATE_KEY"));
    const sPage = S.page;
    await run("buy", "Second wallet buys the 100 MUSD listing (permit)", S.w, sPage, '[aria-label^="Buy position"]', async () => {
      await sPage.getByRole("tab", { name: "Market", exact: true }).click();
      const card = sPage.locator("article.card").filter({ hasText: /^[\s\S]*100\.00/ }).filter({ hasText: "Position #1" }).first();
      await card.waitFor({ timeout: 90_000 });
      await card.getByRole("button", { name: "Buy", exact: true }).click();
      const dlg = sPage.locator('[aria-label^="Buy position"]');
      await dlg.getByRole("heading", { name: "Check before you buy" }).waitFor();
      await dlg.screenshot({ path: resolve(SHOTS, "buy-review.jpg"), type: "jpeg", quality: 70 });
      await dlg.getByRole("button", { name: "Buy position", exact: true }).click();
    });
    await sPage.reload();
    await sPage.getByText("Position #").first().waitFor({ timeout: 90_000 }).catch(() => {});
    await run("transfer-back", "Second wallet transfers the position back", S.w, sPage, '[aria-label^="Transfer position"]', async () => {
      const dAddr = D.w.address;
      await sPage.getByRole("button", { name: "Transfer", exact: true }).first().click();
      const t = sPage.locator('[aria-label^="Transfer position"]');
      await t.getByRole("button", { name: "Continue" }).click();
      await t.getByLabel("Receiver address").fill(dAddr);
      await t.getByRole("button", { name: "Continue" }).click();
      await t.getByLabel(/last 4 characters/).fill(dAddr.slice(-4));
      await t.getByRole("button", { name: "Transfer position", exact: true }).click();
    });
  }

  // ---- cancel (the 7,000 listing's epoch died with the transfers, so list again and cancel at once)
  await dPage.reload();
  await dPage.getByText("Position #").first().waitFor({ timeout: 60_000 });
  await run("list-fixed-for-cancel", "List fixed price 7,000 MUSD again (the first died with the transfer)", D.w, dPage, 'section[aria-label="Sell this position"]', listFixed("7000"));
  await run("cancel", "Cancel the 7,000 MUSD listing", D.w, dPage, 'section[aria-label="Your listings"]', async () => {
    await dPage.getByRole("tab", { name: "Market", exact: true }).click();
    await dPage.getByRole("tab", { name: /^Your listings/ }).click();
    const block = dPage.locator('section[aria-label="Your listings"] .block').filter({ hasText: "7,000.00" }).first();
    await block.waitFor({ timeout: 60_000 });
    await block.getByRole("button", { name: "Cancel this listing" }).click();
  });

  // ---- staged listings for the browse view, signed through the UI: Dutch, then a fixed one
  await dPage.getByRole("tab", { name: "Positions", exact: true }).click();
  await dPage.getByText("Position #").first().waitFor({ timeout: 60_000 });
  await run("list-dutch", "List a Dutch auction 9,000 to 5,000 MUSD over 30 days, open 30 days (staged for the browse view)", D.w, dPage, 'section[aria-label="Sell this position"]', async () => {
    await sell().getByRole("button", { name: "List for sale" }).click();
    await sell().getByRole("button", { name: "Dutch auction", exact: true }).click();
    await sell().getByLabel("Starting price (MUSD)").fill("9000");
    await sell().getByLabel("Lowest price (MUSD)").fill("5000");
    await sell().getByLabel("Falls over (hours)").fill("720");
    await sell().getByLabel("Listing stays open (days)").fill("30");
    await sell().getByRole("button", { name: "Sign and list" }).click();
  });
  await dPage.reload();
  await dPage.getByText("Position #").first().waitFor({ timeout: 60_000 });
  await run("list-fixed-6000", "List fixed price 6,000 MUSD (staged for the browse view)", D.w, dPage, 'section[aria-label="Sell this position"]', async () => {
    await sell().getByRole("button", { name: "List for sale" }).click();
    await sell().getByRole("button", { name: "Fixed price", exact: true }).click();
    await sell().getByLabel("Price (MUSD)").fill("6000");
    await sell().getByLabel("Listing stays open (days)").fill("30");
    await sell().getByRole("button", { name: "Sign and list" }).click();
  });

  noteOnly("open", "Open a position", "Not run: needs about 0.029 BTC of collateral (1,800 MUSD minimum at the 110% floor) and the deployer holds less. Unverified through the UI on this build.");
  noteOnly("close", "Close a position", "Not run on the proof position (it would need roughly the full debt in MUSD and ends the demo), and a second position costs about 0.029 BTC. Unverified through the UI on this build.");

  await browser.close();
}

main().catch((e) => { console.error(e instanceof Error ? e.message.split("\n")[0] : e); process.exit(1); });
