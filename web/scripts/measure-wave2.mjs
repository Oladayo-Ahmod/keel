// Overflow check at 390 and 360 px for the wave 2 fixture (listings, Dutch chart, guardian), the buy
// review step, and the two static content pages. Build with NEXT_PUBLIC_PREVIEW=1 NEXT_PUBLIC_WAVE2=1, serve, then:
//   npm i --no-save playwright-core
//   CHROME=/path/to/chrome-headless-shell node scripts/measure-wave2.mjs http://127.0.0.1:3000 [screenshot-dir]
import { chromium } from "playwright-core";

const base = process.argv[2];
const shots = process.argv[3];
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
let bad = 0;

for (const width of [390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const measure = async (label) => {
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        if (el.closest(".tabs, .hist-scroll") && !el.classList.contains("tabs") && !el.classList.contains("hist-scroll")) continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        if (b.right > vw + 0.5 || b.left < -0.5) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(" ")[0]} left=${b.left.toFixed(0)} right=${b.right.toFixed(0)}`);
      }
      return { vw, sw: document.documentElement.scrollWidth, offenders: offenders.slice(0, 6), n: offenders.length };
    });
    const ok = r.sw <= r.vw && r.n === 0;
    if (!ok) bad++;
    console.log(`[${width}] ${label}: viewport=${r.vw} scrollWidth=${r.sw} ${ok ? "ok" : "OVERFLOW"}`);
    r.offenders.forEach((o) => console.log("     ", o));
  };
  const go = async (path, wait = 2500) => {
    await page.goto(base + path, { waitUntil: "load" });
    await page.waitForTimeout(wait);
  };

  await go("/preview/wave2");
  await measure("wave 2 fixture");
  if (shots) await page.screenshot({ path: `${shots}/wave2-${width}.png`, fullPage: true });
  await page.getByRole("button", { name: "Buy", exact: true }).first().click();
  await page.waitForTimeout(400);
  await measure("buy review open");
  await go("/break-it", 1200);
  await measure("break-it, empty");
  await go("/proof", 1200);
  await measure("proof, empty");
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
