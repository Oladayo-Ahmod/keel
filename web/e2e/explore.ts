import { chromium } from "playwright-core";
import { attachWallet, keyOf } from "./wallet";

async function main() {
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 200)));
const w = await attachWallet(page, "deployer", keyOf("DEPLOYER_PRIVATE_KEY"));
await page.goto("http://127.0.0.1:3100/");
await page.waitForTimeout(12000);
console.log("account", w.address);
console.log((await page.locator("main").innerText()).slice(0, 2500));
console.log("BUTTONS:", (await page.locator("button").allInnerTexts()).map((s) => s.replace(/\n/g, " ")).join(" | "));
await page.screenshot({ path: "/home/blockend_dev/h/explore.png", fullPage: true });
await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
