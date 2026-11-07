// TEST ONLY. Drives the real app through the test-wallet connector (a burner key from .env, signing on the runner side,
// never printed) to check three new features against the live proof position on matsnet. It reads and takes screenshots;
// it never asks the wallet to send anything, and it fails if the wallet was asked to.
//
// Needs the e2e build served on :3100:
//   NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_WAVE2=1 NEXT_PUBLIC_SITE_URL=https://trozu-e2e.example NEXT_DIST_DIR=.next-e2e next build
//   NEXT_PUBLIC_SITE_URL=https://trozu-e2e.example NEXT_DIST_DIR=.next-e2e next start -p 3100
//   CHROME=... npx tsx e2e/features.ts [out-dir]
// Writes docs/features-e2e.json and 390 px screenshots into the out dir (default docs/features-e2e/).
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { attachWallet, keyOf } from "./wallet";

const base = process.env.BASE ?? "http://127.0.0.1:3100";
const out = resolve(process.argv[2] ?? "../docs/features-e2e");
mkdirSync(out, { recursive: true });

const results: Record<string, unknown> = { ranAt: new Date().toISOString(), base };
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " - " + detail : ""}`);
  (results.checks ??= []) as unknown[];
  (results.checks as unknown[]).push({ name, ok, detail });
  if (!ok) failed++;
};
const text = async (l: Locator) => (await l.innerText()).replace(/\s*\n\s*/g, " | ");

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base }).catch(() => undefined);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  const wallet = await attachWallet(page, "deployer", keyOf("DEPLOYER_PRIVATE_KEY"));
  results.account = wallet.address;

  // ---- the position card of the proof position, v2 section
  await page.goto(base + "/");
  const card = page.locator('section[aria-label="Trozu positions"] article.pos-card', { hasText: "Position #1" }).first();
  await card.waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2500);
  check("the proof position (v2 NFT 1) is in the held list, as the deployer", (await card.innerText()).includes("Held by you"));

  // ---- 1. the price hint, inside the real sell panel
  await card.getByRole("button", { name: "List for sale" }).click();
  const hint = card.locator('aside[aria-label="Price estimate"]');
  await hint.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500); // the guardian read that adds the reserve
  const hintText = await text(hint);
  results.priceHint = hintText;
  check("the hint says it is an estimate and shows equity, both rates and the horizon", /Estimate/.test(hintText) && /EQUITY/i.test(hintText) && /LOCKED RATE/i.test(hintText) && /MARKET RATE/i.test(hintText) && /HORIZON/i.test(hintText));
  check("a locked rate equal to the market gives no premium and says so", /none/i.test(hintText) && /no premium to ask for/.test(hintText), hintText.slice(0, 160));
  const suggested = /Suggested price\s*\|?\s*([\d,]+\.\d\d) MUSD/.exec(hintText)?.[1];
  check("it suggests a price", !!suggested, `suggested ${suggested}`);
  await card.getByRole("button", { name: /^Use as price$/ }).click();
  const filled = await card.getByLabel(/^Price \(MUSD\)$/).inputValue();
  check("Use as price fills the field with the suggestion and sends nothing", !!suggested && Number(filled) === Number(suggested.replace(/,/g, "")), `field ${filled}`);
  await card.getByRole("button", { name: "Dutch auction" }).click();
  await page.waitForTimeout(500);
  const dutchText = await text(hint);
  check("with no premium there is no auction range, and it says use a fixed price", /no premium to fall through/.test(dutchText));
  await card.getByRole("button", { name: "Fixed price" }).click();
  await hint.screenshot({ path: `${out}/price-hint-390.png` });
  await card.getByRole("button", { name: "Back" }).click();

  // ---- 2. the what-if simulator on the proof position
  const sim = card.locator('section[aria-label="What-if simulator"]');
  await sim.scrollIntoViewIfNeeded();
  check("the simulator is marked a model, not a prediction", /Model, not a prediction/.test(await sim.innerText()));
  const rest = await text(sim.locator(".whatif-out"));
  results.whatIfAtRest = rest;
  check("at rest the model agrees with the contract's own preview", /same answer as the contract's own preview/.test(await sim.innerText()), (await sim.innerText()).match(/At today's numbers[^.]*\./)?.[0] ?? "");
  const pressure = sim.getByLabel(/Redemption pressure/);
  check("the redemption slider is off until the buffer is checked", await pressure.isDisabled());
  await sim.getByRole("button", { name: "Check buffer to enable" }).click();
  await page.waitForFunction(() => !(document.querySelector('input[id^="rp-"]') as HTMLInputElement | null)?.disabled, null, { timeout: 90_000 });
  const bufferLine = (await sim.innerText()).match(/Buffer now:[^.]*\./)?.[0];
  results.buffer = bufferLine;
  check("checking the buffer shows it and enables the slider", !!bufferLine, bufferLine ?? "");
  await sim.getByLabel(/BTC price/).fill("-45");
  await pressure.fill("120");
  await page.waitForTimeout(900);
  const moved = await text(sim.locator(".whatif-out"));
  results.whatIfMoved = moved;
  check("a 45% drop with 120% pressure changes the ratio and shows a guardian line", /COLLATERAL RATIO/i.test(moved) && /GUARDIAN/i.test(moved) && moved !== rest, moved.slice(0, 240));
  await sim.screenshot({ path: `${out}/what-if-390.png` });
  await sim.getByRole("button", { name: "Reset" }).click();

  // ---- 3. the share page for v2 NFT 1
  await page.goto(base + "/position/2/1");
  await page.getByRole("button", { name: "Copy link" }).waitFor({ timeout: 60_000 });
  await page.locator("article.pos-card", { hasText: "Position #1" }).first().waitFor({ timeout: 90_000 });
  check("the share page shows the position and the share bar", (await page.locator("main").innerText()).includes("Preview image"));
  await page.getByRole("button", { name: "Copy link" }).click();
  await page.waitForTimeout(400);
  const status = await page.locator('[role="status"]', { hasText: /copied|Could not copy/ }).first().innerText().catch(() => "");
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => "unreadable"));
  check("Copy link copies this page's address", /Link copied/.test(status) && clip.endsWith("/position/2/1"), `${status} / ${clip}`);
  const og = await page.locator('meta[property="og:image"]').getAttribute("content");
  const tw = await page.locator('meta[name="twitter:card"]').getAttribute("content");
  results.meta = { ogImage: og, twitterCard: tw };
  check("the page carries an absolute og:image and a large twitter card", !!og && /^https:\/\/trozu-e2e\.example\/og\/position\/2\/1$/.test(og) && tw === "summary_large_image", `${og} ${tw}`);
  const img = await page.evaluate(async () => {
    const r = await fetch("/og/position/2/1");
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), bytes: b.length, png: b[0] === 0x89 && b[1] === 0x50 };
  });
  results.image = img;
  check("the image route returns a PNG with a short cache", img.status === 200 && img.type === "image/png" && img.png && img.bytes > 20_000 && /s-maxage=60/.test(img.cache ?? "") && !/immutable/.test(img.cache ?? ""), JSON.stringify(img));
  await page.screenshot({ path: `${out}/share-page-390.png`, fullPage: true });
  const imgPage = await ctx.newPage();
  const imgRes = await imgPage.goto(base + "/og/position/2/1");
  writeFileSync(`${out}/share-image-v2-1.png`, (await imgRes!.body()) as Buffer);
  await imgPage.close();

  // ---- the wallet was never asked to send anything
  check("the wallet was never asked to send a transaction", wallet.log.length === 0, `${wallet.log.length} requests`);
  check("no page error", errors.length === 0, errors.join(" / "));

  writeFileSync(resolve(out, "..", "features-e2e.json"), JSON.stringify(results, null, 2) + "\n");
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message.split("\n").slice(0, 3).join(" / ") : e);
  process.exit(1);
});

export type { Page };
