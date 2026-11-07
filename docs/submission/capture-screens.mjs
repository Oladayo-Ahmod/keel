// Takes the screenshots the deck uses, from a running build of the app with live testnet data.
// Build with NEXT_PUBLIC_SITE_URL=https://example.org NEXT_PUBLIC_WAVE2=1 and serve it, then:
//   CHROME=/path/to/chrome-headless-shell node docs/submission/capture-screens.mjs http://127.0.0.1:3100
// The what-if and price-estimate pictures come from the test-wallet run (docs/features-e2e/), which drove the real
// sell panel and simulator on the live proof position; this script crops the what-if one.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// playwright-core lives in web/node_modules, and ES modules do not read NODE_PATH
const { chromium } = createRequire(resolve(import.meta.dirname, "..", "..", "web", "package.json"))("playwright-core");

const base = process.argv[2] ?? "http://127.0.0.1:3100";
const out = resolve(import.meta.dirname, "images");
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

// market: the notice and the first listing
await page.goto(base + "/", { waitUntil: "load" });
await page.getByRole("tab", { name: "Market" }).click();
await page.getByTestId("market-notice").waitFor({ timeout: 60_000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/v2-market.png`, clip: { x: 0, y: 300, width: 430, height: 480 } });

// the break-it page
await page.goto(base + "/break-it", { waitUntil: "load" });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/v2-break-it.png`, clip: { x: 0, y: 0, width: 430, height: 560 } });

// the what-if picture from the test-wallet run: its top part, with the sliders and the first results
// a plain context: the mobile one lays pages out at 980px wide and would shrink the picture
const crop = await (await browser.newContext({ viewport: { width: 390, height: 470 }, deviceScaleFactor: 2 })).newPage();
const src = "data:image/png;base64," + readFileSync(resolve(import.meta.dirname, "..", "features-e2e", "what-if-390.png")).toString("base64");
await crop.setViewportSize({ width: 390, height: 470 });
await crop.setContent(`<body style="margin:0;background:#fff"><img src="${src}" style="width:390px;display:block;margin-top:-140px"></body>`);
await crop.waitForTimeout(500);
await crop.screenshot({ path: `${out}/v2-what-if.png`, clip: { x: 0, y: 0, width: 390, height: 470 } });

await browser.close();
console.log("captured v2-market, v2-break-it, v2-what-if into", out);
