// Clicks through every tab of the manage panel on the /preview fixture at 390 and 360 px and
// reports horizontal overflow. Build with NEXT_PUBLIC_PREVIEW=1 and serve, then:
//   npm i --no-save playwright-core
//   CHROME=/path/to/chrome-headless-shell node scripts/measure-manage.mjs http://127.0.0.1:3000 [screenshot-dir]
import { chromium } from "playwright-core";

const base = process.argv[2];
const shots = process.argv[3];
const widths = [390, 360];
const tabs = ["Add collateral", "Withdraw", "Borrow", "Repay", "Refinance", "Close", "Claim surplus", "Sweep"];

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
let bad = 0;

for (const width of widths) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(base + "/preview", { waitUntil: "load" });
  await page.waitForTimeout(2500);

  const measure = async (label) => {
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        // the tab strip scrolls sideways on purpose, so only its own box has to fit
        if (el.closest(".tabs") && !el.classList.contains("tabs")) continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        if (b.right > vw + 0.5 || b.left < -0.5) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} left=${b.left.toFixed(0)} right=${b.right.toFixed(0)}`);
      }
      return { vw, sw: document.documentElement.scrollWidth, offenders: offenders.slice(0, 6), n: offenders.length };
    });
    const ok = r.sw <= r.vw && r.n === 0;
    if (!ok) bad++;
    console.log(`[${width}] ${label}: viewport=${r.vw} scrollWidth=${r.sw} ${ok ? "ok" : "OVERFLOW"}`);
    r.offenders.forEach((o) => console.log("     ", o));
  };

  const panel = page.locator('section[aria-label="Manage this position"]').first();
  await measure("preview with manage panel");
  for (const t of tabs) {
    await panel.getByRole("tab", { name: t }).click();
    await page.waitForTimeout(150);
    await measure(`tab ${t}`);
    if (shots && (t === "Refinance" || t === "Sweep")) {
      await panel.screenshot({ path: `${shots}/manage-${t.replace(/\W+/g, "-")}-${width}.png` });
    }
  }
  // tooltip must stay inside the viewport when opened
  await page.locator(".tip-btn").first().click();
  await page.waitForTimeout(150);
  await measure("tooltip open");
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
