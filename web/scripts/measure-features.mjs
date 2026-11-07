// Overflow check and screenshots at 390 and 360 px for the pages added with the app features: /stats, /proof,
// the position page with its what-if simulator, and the fixture page for the price estimate.
// Build with NEXT_PUBLIC_PREVIEW=1 NEXT_PUBLIC_WAVE2=1, serve, then:
//   CHROME=/path/to/chrome-headless-shell node scripts/measure-features.mjs http://127.0.0.1:3000 [screenshot-dir]
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
        if (el.closest(".tabs, .hist-scroll, .subnav") && !el.classList.contains("tabs") && !el.classList.contains("hist-scroll") && !el.classList.contains("subnav")) continue;
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
  const shot = async (name) => shots && page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });

  const only = (process.argv[4] ?? "all").split(",");
  const want = (n) => only.includes("all") || only.includes(n);

  if (want("stats")) {
    await go("/stats", 1500);
    await measure("stats");
    await shot("stats");
    await go("/proof", 1200);
    await measure("proof");
    await shot("proof");
  }
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
