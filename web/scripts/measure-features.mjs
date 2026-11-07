// Overflow check and screenshots at 390 and 360 px for the pages added with the app features: /stats, /proof,
// the position page with its what-if simulator, and the fixture page for the price estimate.
// Build with NEXT_PUBLIC_PREVIEW=1 NEXT_PUBLIC_WAVE2=1, serve, then:
//   CHROME=/path/to/chrome-headless-shell node scripts/measure-features.mjs http://127.0.0.1:3000 [screenshot-dir]
import { chromium } from "playwright-core";

const base = process.argv[2];
const shots = process.argv[3];
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
let bad = 0;
const only = (process.argv[4] ?? "all").split(",");
const want = (n) => only.includes("all") || only.includes(n);

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

  
  if (want("stats")) {
    await go("/stats", 1500);
    await measure("stats");
    await shot("stats");
    await go("/proof", 1200);
    await measure("proof");
    await shot("proof");
  }
  if (want("labels")) {
    await go("/stats", 1500);
    console.log("     stats banner:", (await page.getByTestId("honesty").innerText()).slice(0, 140));
    console.log("     stats other addresses tile:", await page.getByTestId("others").innerText());
    await go("/", 3000);
    await page.getByRole("tab", { name: "Market" }).click();
    // the market scan reads the log in windows and can take a while on the public RPC
    await page.getByTestId("market-notice").waitFor({ timeout: 40000 });
    await page.waitForTimeout(1500);
    await measure("market list");
    await shot("market");
    console.log("     market notice:", (await page.getByTestId("market-notice").innerText()).slice(0, 200));
    console.log("     demo chips:", await page.getByText("Demo listing", { exact: true }).count());
  }
  if (want("position")) {
    for (const path of ["/position/1/2", "/position/2/1"]) {
      await go(path, 6000);
      await measure(`position page ${path}`);
      await shot(`position-${path.replaceAll("/", "_")}`);
    }
    await go("/position/1/99999", 5000);
    await measure("position page, no such id");
    await go("/position/3/1", 800);
    console.log("     bad wave status text:", (await page.locator("body").innerText()).slice(0, 60).replaceAll(String.fromCharCode(10), " | "));
  }
  if (want("whatif")) {
    await go("/preview/wave2", 2500);
    const sec = page.getByTestId("whatif-fixture");
    await measure("what-if, at rest");
    await sec.screenshot({ path: shots ? `${shots}/whatif-rest-${width}.png` : undefined });
    await sec.locator("input[type=range]").nth(0).fill("-45");
    await sec.locator("input[type=range]").nth(1).fill("120");
    await page.waitForTimeout(900);
    await measure("what-if, -45% price and 120% pressure");
    await sec.screenshot({ path: shots ? `${shots}/whatif-moved-${width}.png` : undefined });
    console.log("     result:", (await sec.locator(".whatif-out").innerText()).split("\n").join(" | ").slice(0, 400));
    await page.getByTestId("hint-fixture").screenshot({ path: shots ? `${shots}/hint-${width}.png` : undefined });
    console.log("     hint:", (await page.getByTestId("hint-fixture").innerText()).split("\n").join(" | ").slice(0, 300));
  }
  await ctx.close();
}

// reduced motion: everything must simply be there
if (want("reduced")) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(base + "/stats", { waitUntil: "load" });
  await page.waitForTimeout(800);
  const faded = await page.evaluate(() => [...document.querySelectorAll(".tile")].filter((t) => getComputedStyle(t).opacity !== "1").length);
  console.log(`[reduced motion] stats tiles not fully visible: ${faded}`);
  if (faded) bad++;
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
