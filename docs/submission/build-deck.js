// Builds trozu-deck.pptx and, with --pdf, the same slides as a PDF. Run from the repository root:
//   NODE_PATH=/path/to/node_modules node docs/submission/build-deck.js [--pdf web/public/trozu-deck.pdf]
// needs: pptxgenjs, qrcode (npm). For --pdf also playwright-core and a Chrome (CHROME=/path/to/chrome).
// Images are read from docs/submission/images; docs/submission/capture-screens.mjs takes the live-app ones.
//
// Built for Google Slides: 16:9, Arial and Courier New only, solid fills, PNG pictures,
// no animations, transitions, gradients or transparency.
//
// Every element goes through the small wrapper below, which adds it to the pptx slide and also records it, so the PDF
// is the same slides drawn as HTML (same coordinates in inches) and printed by Chrome. There is no PowerPoint or
// LibreOffice in the build, so the pptx itself has not been opened in an Office program.
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const QRCode = require("qrcode");

const ROOT = path.resolve(__dirname);
const REPO_ROOT = path.resolve(ROOT, "..", "..");
const IMG = (n) => path.join(ROOT, "images", n);
const LIVE = "https://keel-two-roan.vercel.app/";
const REPO = "https://github.com/Oladayo-Ahmod/keel";

// numbers as the runners report them (docs/TEST_PLAN.md), and the facts on the slides, with where each comes from
const FACTS = {
  forgeTests: 260, // forge test, 23 suites
  invariants: 18, // invariant functions in the source
  webTests: 299,
  keeperTests: 24,
  packageTests: 90 + 78 + 45, // sdk, mcp, alerts
  vectors: 503, // docs/REVIEW.md
  mainnetTroves: 3, // docs/MARKET_DATA.md, block 13,040,764
  redemptions: "1,204",
  redeemed: "5.9M",
};

const C = {
  bg: "F7F8FA", card: "ECEFF3", border: "D5DBE3", ink: "172033", muted: "566479", accent: "1D2B3A", white: "FFFFFF",
  green: "2B8765", greenT: "E1F0E9", amber: "B97E0E", amberT: "F6ECD7", red: "BF4338", redT: "F5E3E1",
  amberText: "7A5208", greenText: "1F6A4E", redText: "9B2F26",
};
const F = "Arial";
const MONO = "Courier New";
const TOTAL = 13;

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
// fits a picture inside a box without changing its proportions, centred
function fit(file, boxX, boxY, boxW, boxH) {
  const { w, h } = pngSize(file);
  const r = Math.min(boxW / w, boxH / h);
  return { x: boxX + (boxW - w * r) / 2, y: boxY + (boxH - h * r) / 2, w: w * r, h: h * r };
}

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.title = "Trozu: tradable MUSD positions on Mezo";
pres.author = "Trozu";
pres.theme = { headFontFace: F, bodyFontFace: F };

const recorded = []; // one list of elements per slide, for the PDF

function newSlide(background) {
  const slide = pres.addSlide();
  slide.background = { color: background };
  const els = [];
  recorded.push({ background, els });
  return {
    addText(text, o) { els.push({ k: "text", text, o }); slide.addText(text, o); },
    addShape(type, o) { els.push({ k: "shape", type, o }); slide.addShape(type, o); },
    addImage(o) { els.push({ k: "image", o }); slide.addImage(o); },
    addNotes(t) { slide.addNotes(t); },
  };
}

function frame(n, title, notes) {
  const s = newSlide(C.bg);
  if (title) {
    s.addText(title, { x: 0.6, y: 0.4, w: 8.8, h: 0.75, fontFace: F, fontSize: 28, bold: true, color: C.ink, margin: 0, valign: "middle", isTextBox: true, fit: "shrink", objectName: "Title" });
  }
  s.addText("Trozu  |  Mezo testnet  |  not audited", { x: 0.6, y: 5.18, w: 5, h: 0.25, fontFace: F, fontSize: 10, color: C.muted, margin: 0, isTextBox: true, objectName: "Footer" });
  s.addText(`${n} / ${TOTAL}`, { x: 8.4, y: 5.18, w: 1, h: 0.25, fontFace: F, fontSize: 10, color: C.muted, align: "right", margin: 0, isTextBox: true, objectName: "Page" });
  s.addNotes(notes);
  return s;
}

function card(s, x, y, w, h, fill = C.card, name = "Card") {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { color: C.border, width: 0.75 }, objectName: name });
}

function chip(s, text, x, y, w, kind) {
  const map = { green: [C.greenT, C.greenText], amber: [C.amberT, C.amberText], red: [C.redT, C.redText], ink: [C.accent, C.white], grey: [C.card, C.muted] };
  const [fill, color] = map[kind];
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h: 0.3, rectRadius: 0.15, fill: { color: fill }, line: { color: fill, width: 0.5 }, objectName: "Chip" });
  s.addText(text, { x, y, w, h: 0.3, fontFace: F, fontSize: 11, bold: true, color, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: "Chip text" });
}

function num(s, n, x, y) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: 0.36, h: 0.36, fill: { color: C.accent }, line: { color: C.accent, width: 0.5 }, objectName: "Number" });
  s.addText(String(n), { x, y, w: 0.36, h: 0.36, fontFace: F, fontSize: 13, bold: true, color: C.white, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: "Number text" });
}

function arrow(s, x1, y, x2) {
  s.addShape(pres.ShapeType.line, { x: x1, y, w: x2 - x1, h: 0, line: { color: C.muted, width: 1.5, endArrowType: "triangle" }, objectName: "Arrow" });
}

function plain(s, x1, y1, x2, y2) {
  s.addShape(pres.ShapeType.line, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), line: { color: C.muted, width: 1.5 }, objectName: "Link line" });
}

// a labelled box for the architecture diagram
function node(s, label, sub, x, y, w, h, fill = C.white) {
  card(s, x, y, w, h, fill, label);
  s.addText(label, { x, y: y + 0.05, w, h: sub ? h * 0.5 : h - 0.1, fontFace: F, fontSize: 12, bold: true, color: C.ink, align: "center", valign: sub ? "bottom" : "middle", margin: 0, isTextBox: true, objectName: `${label} label` });
  if (sub) s.addText(sub, { x, y: y + h * 0.52, w, h: h * 0.42, fontFace: F, fontSize: 9.5, color: C.muted, align: "center", valign: "top", margin: 0, isTextBox: true, objectName: `${label} note` });
}

function bullets(s, items, o) {
  s.addText(items.map((t, i) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: i < items.length - 1 } })), { fontFace: F, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 4, isTextBox: true, ...o });
}

// ====================================================================================================== the slides
async function buildSlides() {
  // ---------------------------------------------------------------- 1 title
  {
    const s = frame(
      1,
      null,
      "Trozu makes a MUSD position on Mezo something you can hand to someone else, and something that can defend itself against redemption within limits the holder sets. A trove normally belongs to one address and cannot move. Trozu puts it in a vault controlled by an NFT. It is live on Mezo testnet, the link and QR code are on screen, and it is not audited. Formerly KEEL.",
    );
    s.addText("Trozu", { x: 0.6, y: 1.05, w: 5.2, h: 1.1, fontFace: F, fontSize: 72, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Wordmark" });
    s.addText("Tradable MUSD positions on Mezo", { x: 0.6, y: 2.2, w: 5.6, h: 0.5, fontFace: F, fontSize: 24, color: C.muted, margin: 0, isTextBox: true, objectName: "Subtitle" });
    s.addText("A trove inside a vault, controlled by an NFT. Sell it with bounded settlement, or leave a guardian watching it.", {
      x: 0.6, y: 2.85, w: 5.4, h: 0.8, fontFace: F, fontSize: 16, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: "Tagline",
    });
    s.addText("keel-two-roan.vercel.app", { x: 0.6, y: 3.85, w: 5.2, h: 0.4, fontFace: F, fontSize: 18, bold: true, color: C.accent, margin: 0, isTextBox: true, hyperlink: { url: LIVE, tooltip: "Trozu live app" }, objectName: "Live link" });
    chip(s, "Testnet. Not audited.", 0.6, 4.45, 2.1, "amber");
    s.addText("Formerly KEEL", { x: 2.9, y: 4.45, w: 2.0, h: 0.3, fontFace: F, fontSize: 12, color: C.muted, margin: 0, valign: "middle", isTextBox: true, objectName: "Formerly" });

    const qr = await QRCode.toBuffer(LIVE, { errorCorrectionLevel: "M", margin: 1, width: 640, color: { dark: "#172033", light: "#FFFFFF" } });
    fs.writeFileSync(IMG("qr-live-app.png"), qr);
    card(s, 6.45, 1.0, 2.95, 3.45, C.white, "QR card");
    s.addImage({ path: IMG("qr-live-app.png"), x: 6.75, y: 1.25, w: 2.35, h: 2.35, altText: "QR code linking to the live Trozu app", objectName: "QR code" });
    s.addText("Open the live app", { x: 6.45, y: 3.75, w: 2.95, h: 0.5, fontFace: F, fontSize: 14, bold: true, color: C.ink, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: "QR caption" });
  }

  // ---------------------------------------------------------------- 2 problem
  {
    const s = frame(
      2,
      "Two things a MUSD trove cannot do",
      "A trove belongs to one address and cannot be moved. To hand a position to someone else you repay, close and reopen at today's rate, and you pay the opening fee again. And redemptions take collateral from the lowest-ratio troves first, so a borrower near the bottom of the list has no standing defense: the only answer is to notice and top up by hand.",
    );
    card(s, 0.6, 1.45, 4.3, 3.3, C.card, "Handover card");
    num(s, 1, 0.85, 1.7);
    s.addText("It cannot be handed over", { x: 0.85, y: 2.2, w: 3.8, h: 0.4, fontFace: F, fontSize: 18, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Handover title" });
    bullets(s, ["A trove belongs to one address.", "To move it: repay, close, reopen.", "The locked rate is lost and the opening fee is paid again."], { x: 0.85, y: 2.75, w: 3.8, h: 1.8, fontSize: 14, color: C.muted });
    card(s, 5.1, 1.45, 4.3, 3.3, C.card, "Redemption card");
    num(s, 2, 5.35, 1.7);
    s.addText("It has no standing defense", { x: 5.35, y: 2.2, w: 3.8, h: 0.4, fontFace: F, fontSize: 18, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Redemption title" });
    bullets(s, ["Redeemers take the lowest-ratio troves first.", "A borrower can only notice and top up by hand.", "Nobody else can help, inside any limit."], { x: 5.35, y: 2.75, w: 3.8, h: 1.8, fontSize: 14, color: C.muted });
  }

  // ---------------------------------------------------------------- 3 what the chain says
  {
    const s = frame(
      3,
      "What the chain says",
      "These are Mezo mainnet figures at block 13,040,764 from docs/MARKET_DATA.md. The book is three troves. The global interest rate has been 1.00% since block 0, so a locked rate has no price today. About 5.9 million MUSD has been redeemed across 1,204 redemptions, so redemption is the dominant event. Trozu's revenue today is zero: nothing is deployed on mainnet.",
    );
    const stats = [
      [String(FACTS.mainnetTroves), "active troves on mainnet", "71,696 MUSD of debt, 17.47 BTC"],
      ["1.00%", "global rate since block 0", "No rate ever proposed. All 641 opens and 215 refinances locked 100 bps."],
      [FACTS.redeemed, "MUSD redeemed", `${FACTS.redemptions} redemptions. Lowest ratio first.`],
      ["0", "Trozu revenue today", "Nothing deployed on mainnet. No mainnet sale."],
    ];
    const w = 2.05, g = 0.2;
    stats.forEach(([n, l, b], i) => {
      const x = 0.6 + i * (w + g);
      card(s, x, 1.4, w, 2.65, i === 3 ? C.amberT : C.white, `Stat ${i + 1}`);
      s.addText(n, { x, y: 1.5, w, h: 0.8, fontFace: F, fontSize: 38, bold: true, color: i === 3 ? C.amberText : C.ink, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: `Stat number ${i + 1}` });
      s.addText(l, { x: x + 0.12, y: 2.35, w: w - 0.24, h: 0.55, fontFace: F, fontSize: 12.5, bold: true, color: C.ink, align: "center", valign: "top", margin: 0, isTextBox: true, objectName: `Stat label ${i + 1}` });
      s.addText(b, { x: x + 0.14, y: 2.95, w: w - 0.28, h: 1.0, fontFace: F, fontSize: 10.5, color: C.muted, align: "center", valign: "top", margin: 0, isTextBox: true, objectName: `Stat body ${i + 1}` });
    });
    s.addText("Mezo mainnet, block 13,040,764 (2026-11-06). Large in flow, small in stock. Source: docs/MARKET_DATA.md.", { x: 0.6, y: 4.3, w: 8.8, h: 0.5, fontFace: F, fontSize: 12, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: "Source" });
  }

  // ---------------------------------------------------------------- 4 solution
  {
    const s = frame(
      4,
      "A vault holds the trove. An NFT holds the vault.",
      "Trozu opens each trove from a vault contract and puts the vault under an NFT. The vault asks the NFT who owns it on every call, so there is no stored owner to update. Send the NFT and the whole position moves. A market contract sells positions and a keeper can trigger the guardian, which sits in the vault.",
    );
    card(s, 0.6, 1.3, 5.05, 3.7, C.bg, "Diagram frame");
    node(s, "Holder", "wallet", 0.8, 1.45, 1.35, 0.6);
    arrow(s, 2.18, 1.75, 3.55);
    s.addText("owns", { x: 2.2, y: 1.45, w: 1.3, h: 0.28, fontFace: F, fontSize: 9.5, color: C.muted, align: "center", margin: 0, isTextBox: true, objectName: "owns" });
    node(s, "TrozuNFT", "ERC-721", 3.6, 1.45, 1.8, 0.6);
    plain(s, 4.5, 2.05, 4.5, 2.7);
    s.addText("ownerOf on every call", { x: 4.55, y: 2.2, w: 1.1, h: 0.45, fontFace: F, fontSize: 9, color: C.muted, margin: 0, valign: "middle", isTextBox: true, objectName: "ownerOf" });
    node(s, "TrozuVault", "one trove each, holds the guardian reserve", 3.3, 2.7, 2.2, 0.85, C.card);
    node(s, "TrozuMarket", "signed listings, bounds at settlement", 0.8, 2.75, 1.95, 0.75);
    plain(s, 2.75, 3.12, 3.35, 3.12);
    node(s, "Keeper", "calls execute", 0.8, 3.95, 1.35, 0.6);
    plain(s, 2.15, 4.25, 3.9, 4.25);
    plain(s, 3.9, 3.55, 3.9, 4.25);
    node(s, "Mezo MUSD core", "the vault is the trove's borrower", 3.0, 4.35, 2.4, 0.55);
    plain(s, 4.5, 3.55, 4.5, 4.35);

    const pts = [
      ["The vault is the borrower", "One trove per vault, opened by the factory."],
      ["The NFT owns the vault", "ownerOf is read on every holder call. A transfer locks out the old holder."],
      ["Sale and guardian sit on top", "The market checks the buyer's bounds. The guardian acts inside the holder's caps."],
    ];
    pts.forEach(([h, b], i) => {
      const y = 1.4 + i * 1.2;
      num(s, i + 1, 5.95, y + 0.02);
      s.addText(h, { x: 6.45, y, w: 2.95, h: 0.4, fontFace: F, fontSize: 15, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: `Point ${i + 1}` });
      s.addText(b, { x: 6.45, y: y + 0.4, w: 2.95, h: 0.7, fontFace: F, fontSize: 12, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Point body ${i + 1}` });
    });
  }

  // ---------------------------------------------------------------- 5 marketplace
  {
    const s = frame(
      5,
      "Marketplace: bounds checked at settlement",
      "The seller signs a listing, fixed price or falling. The buyer commits to bounds on collateral, debt, rate, reserve and price. One transaction checks every bound, pays the seller and the fee, and moves the NFT, so a seller who changes the position after listing only makes the sale fail. On testnet a 100 MUSD sale settled with the fee of 0.25 MUSD, and a Dutch auction from 120 down to 60 sold at 115.67 MUSD. The refusals on the right are real reverts from the proof run.",
    );
    const steps = [
      ["Seller signs a listing", "Fixed price or a falling price. Published as an event."],
      ["Buyer sets bounds", "Collateral, debt, rate, reserve and the most they will pay."],
      ["One transaction", "Bounds checked, seller and fee paid, NFT moved. Or it reverts."],
    ];
    steps.forEach(([h, b], i) => {
      const y = 1.35 + i * 1.12;
      card(s, 0.6, y, 4.75, 1.0, C.card, `Step card ${i + 1}`);
      num(s, i + 1, 0.8, y + 0.32);
      s.addText(h, { x: 1.3, y: y + 0.1, w: 3.9, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: `Step ${i + 1}` });
      s.addText(b, { x: 1.3, y: y + 0.45, w: 3.9, h: 0.5, fontFace: F, fontSize: 11, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Step body ${i + 1}` });
    });
    card(s, 5.55, 1.35, 3.85, 3.34, C.white, "Refusals card");
    s.addText("Refused on testnet, with the real revert", { x: 5.75, y: 1.45, w: 3.5, h: 0.5, fontFace: F, fontSize: 12.5, bold: true, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: "Refusals title" });
    const refusals = ["ListingInvalid(StaleEpoch)", "CollateralBelowMin", "ReserveBelowMin", "ListingInvalid(Cancelled)", "ListingInvalid(Expired)"];
    refusals.forEach((r, i) => {
      s.addText(r, { x: 5.75, y: 2.05 + i * 0.4, w: 3.5, h: 0.32, fontFace: MONO, fontSize: 11, color: C.redText, margin: 0, valign: "middle", isTextBox: true, objectName: `Refusal ${i + 1}` });
    });
    s.addText("Sold: 100 MUSD fixed, fee 0.25 MUSD. Dutch 120 to 60: sold at 115.67.", { x: 5.75, y: 4.05, w: 3.5, h: 0.55, fontFace: F, fontSize: 10.5, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: "Sales" });
    chip(s, "Fee: 25 bps, capped at 100 in code", 0.6, 4.75, 3.2, "grey");
  }

  // ---------------------------------------------------------------- 6 guardian
  {
    const s = frame(
      6,
      "A bounded guardian anyone can trigger",
      "The holder funds a reserve that stays in the vault and sets a policy: a floor and target ratio, caps per action and per period, a keeper tip capped in code at 0.0001 BTC, and optionally a redemption-buffer threshold. Anyone can call execute, and it acts only if the vault's own planner says the policy calls for it. It never refinances. On testnet a keeper lifted a position from 135.07% to 145.17%, and a redemption defense acted after a complete queue walk. The oracle cannot be moved on testnet, so the proof run set the floor above the current ratio: it shows the mechanism, not how often a holder would need it.",
    );
    card(s, 0.6, 1.35, 4.2, 3.35, C.card, "Policy card");
    s.addText("The holder sets", { x: 0.85, y: 1.45, w: 3.7, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Policy title" });
    bullets(s, [
      "A floor and a target ratio",
      "Caps per action and per period",
      "A reserve, held in the vault",
      "A keeper tip, at most 0.0001 BTC",
      "Optional redemption defense, only after a complete queue walk",
      "It never refinances",
    ], { x: 0.85, y: 1.9, w: 3.75, h: 2.7, fontSize: 12.5 });
    card(s, 5.0, 1.35, 4.4, 3.35, C.white, "Proof card");
    s.addText("Run on Mezo testnet", { x: 5.2, y: 1.45, w: 4.0, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Proof title" });
    s.addText("Floor: ratio 135.07% to 145.17%, tip 0.00001 BTC", { x: 5.2, y: 1.9, w: 4.0, h: 0.5, fontFace: F, fontSize: 12, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: "Floor result" });
    s.addText("0x7d228078…309335", { x: 5.2, y: 2.4, w: 4.0, h: 0.28, fontFace: MONO, fontSize: 10.5, color: C.accent, margin: 0, isTextBox: true, hyperlink: { url: "https://explorer.test.mezo.org/tx/0x7d2280786535e8ce51456007e12073906266a3afc39a8e6341ac90763a309335" }, objectName: "Floor tx" });
    s.addText("Redemption defense acted after a complete walk", { x: 5.2, y: 2.85, w: 4.0, h: 0.5, fontFace: F, fontSize: 12, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: "Defense result" });
    s.addText("0xbc7158fe…83ac3d", { x: 5.2, y: 3.35, w: 4.0, h: 0.28, fontFace: MONO, fontSize: 10.5, color: C.accent, margin: 0, isTextBox: true, hyperlink: { url: "https://explorer.test.mezo.org/tx/0xbc7158fe8ceb62a08a4360d6d407eca5463640fb3a946950edfa5fd80a83ac3d" }, objectName: "Defense tx" });
    s.addText("Inside the policy: NothingToDo(Healthy). After a transfer: NothingToDo(PolicyStale).", { x: 5.2, y: 3.8, w: 4.0, h: 0.5, fontFace: F, fontSize: 11, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: "Refusals" });
    chip(s, "Oracle not movable on testnet: floor set above the ratio", 0.6, 4.75, 4.3, "amber");
  }

  // ---------------------------------------------------------------- 7 product
  {
    const s = frame(
      7,
      "The product, live",
      "These are the real app screens on Mezo testnet with live data. The market list marks listings from the team's own wallets as demo listings, because all activity so far is the team's. The price estimate in the sell flow shows its inputs and gives no premium when the locked rate equals the market rate. The what-if simulator moves the BTC price and redemption pressure on position 1, and is marked a model, not a prediction.",
    );
    const items = [
      ["v2-market.png", 2.75, "Market: listings from the team's wallets are marked Demo listing (live)", 2.95],
      ["../../features-e2e/price-hint-390.png", 2.85, "Price estimate in the sell flow: no premium when the rates match (live position)", 2.95],
      ["v2-what-if.png", 2.75, "What-if simulator on position 1: a model, not a prediction (live position)", 2.95],
    ];
    let x = 0.6;
    items.forEach(([file, w, cap, imgH], i) => {
      const p = file.startsWith("..") ? path.join(ROOT, "images", file) : IMG(file);
      card(s, x, 1.25, w, 3.85, C.white, `Frame ${i + 1}`);
      s.addImage({ path: p, ...fit(p, x + 0.1, 1.35, w - 0.2, imgH), altText: cap, objectName: `Screenshot ${i + 1}` });
      s.addText(cap, { x: x + 0.12, y: 4.42, w: w - 0.24, h: 0.62, fontFace: F, fontSize: 10, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Caption ${i + 1}` });
      x += w + 0.15;
    });
  }

  // ---------------------------------------------------------------- 8 honesty
  {
    const s = frame(
      8,
      "We publish what broke",
      "The break-it page lists attacks that were tried and what happened, including the ones that worked. An AI-assisted review, which is not an independent audit, found three exploits that were fixed with regression tests: a recovery-mode top-up of a liquidatable trove, dust actions turned into keeper tips, and a seller emptying the reserve after listing. Later, the project's own checks found two more in the app: the what-if simulator disagreed with the contract's planner in 81 of 503 states, and the buffer check asked the wrong lens about a v2 position. Both are fixed. The proof page also lists two claims as open.",
    );
    card(s, 0.6, 1.3, 5.35, 3.65, C.card, "Findings card");
    s.addText("Tried, worked, fixed", { x: 0.85, y: 1.4, w: 4.9, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Findings title" });
    bullets(s, [
      "Guardian topped up a liquidatable trove in Recovery Mode",
      "Dust actions turned the allowance into keeper tips",
      "A seller could empty the reserve after listing",
      `Simulator disagreed with the contract in 81 of ${FACTS.vectors} states`,
      "Buffer check asked the wrong lens about a v2 position",
    ], { x: 0.85, y: 1.85, w: 4.95, h: 2.3, fontSize: 12.5 });
    s.addText("The first three came from an AI-assisted review, not an audit. The last two came from our own tests and a real browser run.", { x: 0.85, y: 4.15, w: 4.95, h: 0.7, fontFace: F, fontSize: 10.5, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: "Findings note" });
    card(s, 6.15, 1.3, 3.25, 3.65, C.white, "Page card");
    s.addImage({ path: IMG("v2-break-it.png"), ...fit(IMG("v2-break-it.png"), 6.25, 1.4, 3.05, 2.85), altText: "The break-it page", objectName: "Break-it page" });
    s.addText("The /break-it page. /proof lists two claims as open.", { x: 6.28, y: 4.32, w: 3.0, h: 0.55, fontFace: F, fontSize: 10, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: "Page caption" });
  }

  // ---------------------------------------------------------------- 9 revenue
  {
    const s = frame(
      9,
      "Revenue model, and where it stands",
      "One source: a fee on each marketplace sale, 25 basis points of the sale price, capped at 100 in the contract. The seller pays in effect: the buyer pays the listed price and the contract splits it into the seller's share and the fee. One recipient address is fixed at deployment, the deployer on testnet. There is no token, no subscription, and no fee on opening, transfer or the guardian. Revenue today is zero. On testnet the team ran three sales for 315.67 MUSD of volume and 0.79 MUSD of fee, paid to its own address, which is test traffic and not revenue. If rates stay flat there is no rate premium to sell, and the fee stays near zero unless sales happen.",
    );
    card(s, 0.6, 1.3, 5.2, 3.65, C.white, "Model card");
    const rows = [
      ["What", "25 bps of the sale price, rounded up. The contract refuses more than 100 bps."],
      ["Who pays", "The seller, in effect. The buyer pays the listed price; the seller receives it minus the fee."],
      ["Who receives", "One address, fixed in the constructor. No owner, no setter. The deployer on testnet."],
      ["Nothing else", "No token, no subscription. The keeper tip goes to the keeper."],
    ];
    rows.forEach(([h, b], i) => {
      const y = 1.42 + i * 0.86;
      s.addText(h, { x: 0.85, y, w: 1.25, h: 0.3, fontFace: F, fontSize: 12, bold: true, color: C.muted, margin: 0, isTextBox: true, objectName: `Row ${i + 1}` });
      s.addText(b, { x: 2.1, y, w: 3.55, h: 0.8, fontFace: F, fontSize: 11.5, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: `Row body ${i + 1}` });
    });
    card(s, 6.0, 1.3, 3.4, 1.85, C.amberT, "Today card");
    s.addText("Revenue today: zero", { x: 6.2, y: 1.4, w: 3.0, h: 0.35, fontFace: F, fontSize: 15, bold: true, color: C.amberText, margin: 0, isTextBox: true, objectName: "Today title" });
    s.addText("Mainnet: nothing deployed. Testnet: 3 team-run sales, 315.67 MUSD volume, 0.79 MUSD fee, paid to the team's own address. Test traffic.", { x: 6.2, y: 1.8, w: 3.0, h: 1.3, fontFace: F, fontSize: 11, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: "Today body" });
    card(s, 6.0, 3.3, 3.4, 1.65, C.card, "Flat card");
    s.addText("If rates stay flat", { x: 6.2, y: 3.4, w: 3.0, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Flat title" });
    s.addText("No rate premium. The guardian and the handover still stand. The fee stays near zero without sales.", { x: 6.2, y: 3.8, w: 3.0, h: 1.1, fontFace: F, fontSize: 11, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: "Flat body" });
  }

  // ---------------------------------------------------------------- 10 tests
  {
    const s = frame(
      10,
      "Tested hard. Not audited.",
      `${FACTS.forgeTests} Foundry tests as forge reports them, ${FACTS.invariants} invariant functions, ${FACTS.webTests} web tests, ${FACTS.keeperTests} keeper tests, and ${FACTS.packageTests} tests across the SDK, the MCP server and the alerts package. The Foundry tests deploy the real MUSD contracts and replace only the oracle. A Foundry test also writes ${FACTS.vectors} guardian states that the web tests replay against the simulator. It is testnet only and not audited; the review was AI-assisted, which is not an audit.`,
    );
    const stats = [
      [String(FACTS.forgeTests), "Foundry tests"],
      [String(FACTS.invariants), "invariant tests"],
      [String(FACTS.webTests), "web tests"],
      [String(FACTS.keeperTests), "keeper tests"],
      [String(FACTS.packageTests), "SDK, MCP, alerts tests"],
    ];
    const sw = 1.64, sg = 0.15;
    stats.forEach(([n, l], i) => {
      const x = 0.6 + i * (sw + sg);
      card(s, x, 1.25, sw, 1.2, C.white, `Stat ${i + 1}`);
      s.addText(n, { x, y: 1.3, w: sw, h: 0.65, fontFace: F, fontSize: 34, bold: true, color: C.ink, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: `Stat number ${i + 1}` });
      s.addText(l, { x, y: 1.95, w: sw, h: 0.4, fontFace: F, fontSize: 11, color: C.muted, align: "center", valign: "top", margin: 0, isTextBox: true, objectName: `Stat label ${i + 1}` });
    });
    card(s, 0.6, 2.65, 5.0, 2.3, C.card, "Invariants card");
    s.addText("What the invariants hold", { x: 0.85, y: 2.75, w: 4.5, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Invariants title" });
    bullets(s, [
      "Only the current holder moves funds",
      "A transfer clears permissions, listings and policies",
      "The guardian stays inside the policy",
      "The market is atomic and holds nothing",
      "Payouts go to the caller",
    ], { x: 0.85, y: 3.15, w: 4.55, h: 1.7, fontSize: 12.5 });
    card(s, 5.8, 2.65, 3.6, 2.3, C.card, "Method card");
    s.addText("How", { x: 6.05, y: 2.75, w: 3.1, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Method title" });
    bullets(s, ["Real MUSD, only the oracle mocked", `${FACTS.vectors} contract answers replayed on the simulator`, "Fuzz of redemption, liquidation, transfer and sale"], { x: 6.05, y: 3.15, w: 3.15, h: 1.2, fontSize: 11.5 });
    chip(s, "Not independently audited", 6.05, 4.45, 2.35, "amber");
  }

  // ---------------------------------------------------------------- 11 build on it
  {
    const s = frame(
      11,
      "Build on it",
      "Three TypeScript packages sit next to the app. The SDK reads positions, listings and guardians and builds unsigned transactions with explicit gas limits; it never signs. The MCP server gives Claude Desktop and Claude Code read-only tools over the SDK; its stdio handshake is tested, but it has not been loaded in a real client. The alerts package posts to a webhook when a guarded position nears its floor; a workflow runs it only when its secret is set.",
    );
    const pk = [
      ["@trozu/sdk", "Read positions, listings and guardians. Build unsigned transactions with explicit gas limits.", "Never signs", "green"],
      ["@trozu/mcp", "Read-only tools over the SDK for Claude Desktop and Claude Code.", "Handshake tested only", "amber"],
      ["@trozu/alerts", "Posts to a webhook when a guarded position nears its floor or the keeper acts.", "No keys. Needs its secret", "green"],
    ];
    const w = 2.8, g = 0.2;
    pk.forEach(([h, b, c, kind], i) => {
      const x = 0.6 + i * (w + g);
      card(s, x, 1.3, w, 3.5, C.card, `Package ${i + 1}`);
      s.addText(h, { x: x + 0.25, y: 1.5, w: w - 0.5, h: 0.4, fontFace: MONO, fontSize: 15, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: `Package name ${i + 1}` });
      s.addText(b, { x: x + 0.25, y: 2.1, w: w - 0.5, h: 1.4, fontFace: F, fontSize: 13, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Package body ${i + 1}` });
      chip(s, c, x + 0.2, 3.85, w - 0.4, kind);
    });
  }

  // ---------------------------------------------------------------- 12 who and next
  {
    const s = frame(
      12,
      "Who uses it first, and what comes next",
      "None of this is observed: I have not interviewed anyone, and the only users so far are the team's own wallets. The first users the data points to are holders near the front of the redemption queue who cannot watch the chain, then people moving a position between wallets, then keepers. What comes next is a real user other than the team, rate-dependent features only if governance moves the rate, and an independent audit before any mainnet deployment. User feedback goes in docs/VIABILITY.md, in the holder's own words.",
    );
    card(s, 0.6, 1.3, 4.3, 3.65, C.card, "First users");
    s.addText("First users (hypotheses)", { x: 0.85, y: 1.4, w: 3.8, h: 0.4, fontFace: F, fontSize: 16, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "First title" });
    bullets(s, [
      "A holder near the front of the redemption queue who cannot watch the chain",
      "Someone moving a position between wallets",
      "A keeper, who earns the tip",
      "A buyer, last: it needs a seller first",
    ], { x: 0.85, y: 1.9, w: 3.8, h: 2.2, fontSize: 12.5 });
    chip(s, "No users or feedback yet", 0.85, 4.45, 2.4, "amber");
    card(s, 5.1, 1.3, 4.3, 3.65, C.white, "Next");
    s.addText("What comes next", { x: 5.35, y: 1.4, w: 3.8, h: 0.4, fontFace: F, fontSize: 16, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Next title" });
    bullets(s, [
      "A real user: someone other than the team sets a policy or buys a position",
      "Rate-dependent features, only if governance moves the rate (never has)",
      "An independent audit before any mainnet deployment",
    ], { x: 5.35, y: 1.9, w: 3.8, h: 2.4, fontSize: 12.5 });
  }

  // ---------------------------------------------------------------- 13 team and links
  {
    const s = frame(
      13,
      "Team and links",
      "Names, roles and links are on screen. The code, the live app, the proof and break-it pages, the deployments and the threat model are all public, and everything here is testnet only.",
    );
    card(s, 0.6, 1.3, 4.3, 3.65, C.card, "Team card");
    s.addText("Team", { x: 0.85, y: 1.42, w: 3.8, h: 0.4, fontFace: F, fontSize: 18, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Team title" });
    const team = [["[Name]", "[Role]", "[X or LinkedIn]"], ["[Name]", "[Role]", "[X or LinkedIn]"], ["[Name]", "[Role]", "[X or LinkedIn]"]];
    team.forEach((r, i) => {
      const y = 2.0 + i * 0.95;
      s.addText(r[0], { x: 0.85, y, w: 3.8, h: 0.3, fontFace: F, fontSize: 15, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: `Member ${i + 1}` });
      s.addText(r[1], { x: 0.85, y: y + 0.3, w: 3.8, h: 0.28, fontFace: F, fontSize: 12.5, color: C.muted, margin: 0, isTextBox: true, objectName: `Role ${i + 1}` });
      s.addText(r[2], { x: 0.85, y: y + 0.58, w: 3.8, h: 0.28, fontFace: F, fontSize: 12.5, color: C.muted, margin: 0, isTextBox: true, objectName: `Social ${i + 1}` });
    });
    card(s, 5.1, 1.3, 4.3, 3.65, C.white, "Links card");
    s.addText("Links", { x: 5.35, y: 1.42, w: 3.8, h: 0.4, fontFace: F, fontSize: 18, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Links title" });
    const links = [
      ["GitHub", "github.com/Oladayo-Ahmod/keel", REPO],
      ["Live app", "keel-two-roan.vercel.app", LIVE],
      ["Proof and break-it", "keel-two-roan.vercel.app/proof", `${LIVE}proof`],
      ["Deployments", "docs/DEPLOYMENTS.md", `${REPO}/blob/main/docs/DEPLOYMENTS.md`],
      ["Viability", "docs/VIABILITY.md", `${REPO}/blob/main/docs/VIABILITY.md`],
    ];
    links.forEach(([l, t, url], i) => {
      const y = 1.95 + i * 0.58;
      s.addText(l, { x: 5.35, y, w: 3.8, h: 0.24, fontFace: F, fontSize: 11, bold: true, color: C.muted, margin: 0, isTextBox: true, objectName: `Link label ${i + 1}` });
      s.addText(t, { x: 5.35, y: y + 0.23, w: 3.8, h: 0.28, fontFace: F, fontSize: 12.5, color: C.accent, margin: 0, isTextBox: true, hyperlink: { url }, objectName: `Link ${i + 1}` });
    });
  }
}

// ====================================================================================================== the PDF
const PX = 96; // css pixels per inch
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// single quotes: the value goes inside a double-quoted style attribute
const face = (f) => (f === MONO ? "'Courier New','Liberation Mono',monospace" : "Arial,'Liberation Sans',sans-serif");
const hex = (c) => `#${c}`;

function textHtml(el) {
  const o = el.o;
  const px = (o.fontSize || 12) * (PX / 72);
  const align = { left: "flex-start", center: "center", right: "flex-end" }[o.align || "left"];
  const valign = { top: "flex-start", middle: "center", bottom: "flex-end" }[o.valign || "top"];
  const link = (t) => (o.hyperlink ? `<a href="${esc(o.hyperlink.url)}" style="color:inherit;text-decoration:none">${esc(t)}</a>` : esc(t));
  let inner;
  if (Array.isArray(el.text)) {
    const after = (o.paraSpaceAfter || 0) * (PX / 72);
    inner = `<ul style="margin:0;padding-left:${14 * (PX / 72)}px;width:100%">${el.text.map((r) => `<li style="margin-bottom:${after}px">${esc(r.text)}</li>`).join("")}</ul>`;
  } else inner = link(el.text);
  const w = o.w * PX;
  return `<div style="position:absolute;left:${o.x * PX}px;top:${o.y * PX}px;width:${w}px;height:${o.h * PX}px;display:flex;justify-content:${align};align-items:${valign};` +
    `font-family:${face(o.fontFace)};font-size:${px}px;font-weight:${o.bold ? 700 : 400};color:${hex(o.color || C.ink)};text-align:${o.align || "left"};line-height:1.2;overflow:visible">` +
    `<div style="width:100%">${inner}</div></div>`;
}

function shapeHtml(el) {
  const o = el.o;
  const x = o.x * PX, y = o.y * PX, w = o.w * PX, h = o.h * PX;
  const type = el.type;
  if (type === pres.ShapeType.line) {
    const color = hex(o.line.color), t = (o.line.width || 1) * (PX / 72);
    const arrowHead = o.line.endArrowType ? `<div style="position:absolute;right:-1px;top:${-(t * 3)}px;width:0;height:0;border-left:${t * 5}px solid ${color};border-top:${t * 3}px solid transparent;border-bottom:${t * 3}px solid transparent"></div>` : "";
    if (h === 0) return `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:0;border-top:${t}px solid ${color}">${arrowHead}</div>`;
    return `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-left:${t}px solid ${color}"></div>`;
  }
  const radius = type === pres.ShapeType.ellipse ? "50%" : `${(o.rectRadius || 0) * PX}px`;
  return `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box;border-radius:${radius};background:${hex(o.fill.color)};border:${(o.line.width || 0) * (PX / 72)}px solid ${hex(o.line.color)}"></div>`;
}

function imageHtml(el) {
  const o = el.o;
  const b64 = fs.readFileSync(o.path).toString("base64");
  return `<img alt="${esc(o.altText || "")}" src="data:image/png;base64,${b64}" style="position:absolute;left:${o.x * PX}px;top:${o.y * PX}px;width:${o.w * PX}px;height:${o.h * PX}px">`;
}

function deckHtml() {
  const slides = recorded.map((sl) => {
    const body = sl.els.map((el) => (el.k === "text" ? textHtml(el) : el.k === "shape" ? shapeHtml(el) : imageHtml(el))).join("\n");
    return `<section style="position:relative;width:${10 * PX}px;height:${5.625 * PX}px;background:${hex(sl.background)};overflow:hidden;page-break-after:always">${body}</section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Trozu</title><style>@page{size:${10 * PX}px ${5.625 * PX}px;margin:0}html,body{margin:0;padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>${slides.join("\n")}</body></html>`;
}

async function writePdf(target) {
  const { createRequire } = require("module");
  const { chromium } = createRequire(path.join(REPO_ROOT, "web", "package.json"))("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 10 * PX, height: Math.round(5.625 * PX) } });
  await page.setContent(deckHtml(), { waitUntil: "load" });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await page.pdf({ path: target, width: `${10 * PX}px`, height: `${5.625 * PX}px`, printBackground: true, pageRanges: "" });
  const shots = process.env.DECK_SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
    const count = await page.locator("section").count();
    for (let i = 0; i < count; i++) await page.locator("section").nth(i).screenshot({ path: path.join(shots, `slide-${String(i + 1).padStart(2, "0")}.png`) });
  }
  await browser.close();
}

(async () => {
  await buildSlides();
  await pres.writeFile({ fileName: path.join(ROOT, "trozu-deck.pptx") });
  console.log("written", path.join(ROOT, "trozu-deck.pptx"));
  const i = process.argv.indexOf("--pdf");
  if (i > 0) {
    const target = path.resolve(process.argv[i + 1]);
    await writePdf(target);
    console.log("written", target);
  }
})();
