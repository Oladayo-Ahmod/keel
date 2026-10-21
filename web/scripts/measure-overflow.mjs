// Checks for horizontal overflow at 390 and 360 px with a real mobile viewport, on the
// home page, a live position, and the fixture page (cards, open form, transfer steps).
// Build with NEXT_PUBLIC_PREVIEW=1 so /preview exists, serve the app, then:
//   npm i --no-save playwright-core
//   CHROME=/path/to/chrome node scripts/measure-overflow.mjs http://host:3000 [screenshot-dir]
// A plain headless --window-size screenshot is not enough: Chrome enforces a minimum window width.
import { chromium } from "playwright-core";

const base = process.argv[2];
const widths = [390, 360];
const shots = process.argv[3];

const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true });

async function measure(page, label, width) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    const bw = document.body.scrollWidth;
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (b.right > vw + 0.5 || b.left < -0.5) {
        offenders.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ").slice(0, 2).join(".")} left=${b.left.toFixed(0)} right=${b.right.toFixed(0)} w=${b.width.toFixed(0)}`);
      }
    }
    return { vw, sw, bw, offenders: offenders.slice(0, 8), count: offenders.length };
  });
  const flag = r.sw > r.vw ? "OVERFLOW" : "ok";
  console.log(`[${width}] ${label}: viewport=${r.vw} scrollWidth=${r.sw} bodyScroll=${r.bw} ${flag}`);
  if (r.count) r.offenders.forEach((o) => console.log("    ", o));
}

for (const width of widths) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const go = async (path, wait = 2500) => {
    await page.goto(base + path, { waitUntil: "load" });
    await page.waitForTimeout(wait);
  };

  await go("/");
  await measure(page, "home, disconnected", width);

  await go("/?id=1", 9000);
  await measure(page, "positions view, live position #1", width);
  if (shots) await page.screenshot({ path: `${shots}\\live-${width}.png`, fullPage: true });

  // fixtures: cards in several states, open form, empty and error states
  await go("/preview", 3500);
  await measure(page, "preview: cards, open form, states", width);
  if (shots) await page.screenshot({ path: `${shots}\\preview-${width}.png`, fullPage: true });

  // open form with values
  const inputs = page.locator('section[aria-label="Open a position"] input');
  await inputs.nth(1).fill("0.039");
  await page.waitForTimeout(3000);
  await measure(page, "open form with a plan shown", width);

  // transfer flow on the first card, step by step
  const card = page.locator(".pos-card").first();
  await card.getByRole("button", { name: "Transfer" }).click();
  await page.waitForTimeout(400);
  await measure(page, "transfer: review step", width);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator('.transfer input[placeholder="0x…"]').fill("0x1111111111111111111111111111111111111111");
  await page.waitForTimeout(300);
  await measure(page, "transfer: receiver step", width);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForTimeout(2500);
  await measure(page, "transfer: confirm step", width);
  if (shots) await page.screenshot({ path: `${shots}\\transfer-${width}.png`, fullPage: false });

  // the underwater card needs the typed word
  const risky = page.locator(".pos-card").nth(1);
  await risky.getByRole("button", { name: "Transfer" }).click();
  await page.waitForTimeout(400);
  await measure(page, "transfer: underwater warning", width);
  await ctx.close();
}
await browser.close();
