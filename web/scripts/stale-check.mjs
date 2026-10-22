// Fakes a lagging RPC node in a real browser and checks what the app shows.
// Build and serve the app, then:
//   npm i --no-save playwright-core
//   CHROME=/path/to/chrome node scripts/stale-check.mjs http://host:3000
// "always": every answer carries an old head block. The app must show the stale warning and must
// not call the position healthy. "flaky": the first answers are old, later ones are real. The app
// must retry on its own and end up showing the real numbers.
import { chromium } from "playwright-core";

const base = process.argv[2];
const RPC = "https://rpc.test.mezo.org/**";
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " - " + detail : ""}`);
  if (!ok) failed++;
}

async function run(mode, expect) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
  const page = await ctx.newPage();
  let staleServed = 0;
  const freshAfter = mode === "flaky" ? 3 : Infinity;

  await page.route(RPC, async (route) => {
    const response = await route.fetch();
    let json;
    try {
      json = await response.json();
    } catch {
      return route.fulfill({ response });
    }
    const asked = JSON.parse(route.request().postData() || "[]");
    const byId = new Map((Array.isArray(asked) ? asked : [asked]).map((r) => [r.id, r.method]));
    const items = Array.isArray(json) ? json : [json];
    const hasHead = items.some((it) => byId.get(it.id) === "eth_getBlockByNumber");
    if (hasHead && staleServed < freshAfter) {
      staleServed++;
      for (const it of items) {
        if (byId.get(it.id) === "eth_getBlockByNumber" && it.result) {
          it.result.number = "0x" + (16082514).toString(16);
          it.result.timestamp = "0x" + (Math.floor(Date.now() / 1000) - 3600).toString(16);
        }
      }
    }
    await route.fulfill({ response, json: Array.isArray(json) ? items : items[0] });
  });

  await page.goto(`${base}/?id=1`, { waitUntil: "load" });
  await page.waitForTimeout(mode === "flaky" ? 16000 : 24000);
  const text = await page.locator("body").innerText();
  if (process.env.DEBUG_TEXT) console.log(text.slice(0, 700));
  await expect(text, page, staleServed);
  await ctx.close();
}

await run("always", async (text, page, served) => {
  check("always-stale: the warning banner is shown", /Could not reach an up-to-date node/.test(text));
  check("always-stale: the card says Stale data", /Stale data/.test(text));
  check("always-stale: nothing says Healthy", !/Healthy/.test(text));
  check("always-stale: the header pill warns", /Node behind/.test(text));
  check("always-stale: the node was retried before giving up", served >= 4, `${served} stale answers served`);
});

await run("flaky", async (text, page, served) => {
  check("flaky: the app retried past the stale answers", served >= 3, `${served} stale answers served`);
  check("flaky: no stale warning remains", !/Could not reach an up-to-date node/.test(text));
  check("flaky: the real ratio is shown", /Healthy|Watch|At risk|Liquidatable/.test(text));
});

await browser.close();
process.exit(failed ? 1 : 0);
