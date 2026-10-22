// Builds keel-deck.pptx. Run from the repository root:
//   NODE_PATH=/path/to/node_modules node docs/submission/build-deck.js
// needs: pptxgenjs, qrcode (npm). Images are read from docs/submission/images.
//
// Built for Google Slides: 16:9, Arial and Courier New only, solid fills, PNG pictures,
// no animations, transitions, gradients or transparency.
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const QRCode = require("qrcode");

const ROOT = path.resolve(__dirname);
const IMG = (n) => path.join(ROOT, "images", n);
const LIVE = "https://keel-two-roan.vercel.app/";
const REPO = "https://github.com/Oladayo-Ahmod/keel";

// numbers re-measured before building, see the report that accompanies the deck
const FACTS = {
  forgeTests: 90,
  invariants: 7,
  threats: 22,
  webTests: 42,
  brokenVaults: "3 of 3",
  coverageLine: process.env.COV_LINE || "",
};

const C = {
  bg: "F7F8FA",
  card: "ECEFF3",
  border: "D5DBE3",
  ink: "172033",
  muted: "566479",
  accent: "1D2B3A",
  white: "FFFFFF",
  green: "2B8765",
  greenT: "E1F0E9",
  amber: "B97E0E",
  amberT: "F6ECD7",
  red: "BF4338",
  redT: "F5E3E1",
  amberText: "7A5208",
  greenText: "1F6A4E",
  redText: "9B2F26",
};
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

const F = "Arial";
const MONO = "Courier New";
const TOTAL = 11;

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pres.title = "KEEL: tradable MUSD positions on Mezo";
pres.author = "KEEL";
pres.theme = { headFontFace: F, bodyFontFace: F };

function frame(n, title, notes) {
  const s = pres.addSlide();
  s.background = { color: C.bg };
  if (title) {
    s.addText(title, {
      x: 0.6, y: 0.4, w: 8.8, h: 0.75, fontFace: F, fontSize: 30, bold: true, color: C.ink,
      margin: 0, valign: "middle", isTextBox: true, fit: "shrink", objectName: "Title",
    });
  }
  s.addText("KEEL  |  Mezo testnet  |  not audited", {
    x: 0.6, y: 5.18, w: 5, h: 0.25, fontFace: F, fontSize: 10, color: C.muted, margin: 0, isTextBox: true, objectName: "Footer",
  });
  s.addText(`${n} / ${TOTAL}`, {
    x: 8.4, y: 5.18, w: 1, h: 0.25, fontFace: F, fontSize: 10, color: C.muted, align: "right", margin: 0, isTextBox: true, objectName: "Page",
  });
  s.addNotes(notes);
  return s;
}

function card(s, x, y, w, h, fill = C.card, name = "Card") {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { color: C.border, width: 0.75 }, objectName: name,
  });
}

function chip(s, text, x, y, w, kind) {
  const map = {
    green: [C.greenT, C.greenText],
    amber: [C.amberT, C.amberText],
    red: [C.redT, C.redText],
    ink: [C.accent, C.white],
    grey: [C.card, C.muted],
  };
  const [fill, color] = map[kind];
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h: 0.3, rectRadius: 0.15, fill: { color: fill }, line: { color: fill, width: 0.5 }, objectName: "Chip" });
  s.addText(text, { x, y, w, h: 0.3, fontFace: F, fontSize: 11, bold: true, color, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: "Chip text" });
}

function num(s, n, x, y) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: 0.36, h: 0.36, fill: { color: C.accent }, line: { color: C.accent, width: 0.5 }, objectName: "Number" });
  s.addText(String(n), { x, y, w: 0.36, h: 0.36, fontFace: F, fontSize: 13, bold: true, color: C.white, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: "Number text" });
}

function arrow(s, x1, y, x2) {
  s.addShape(pres.ShapeType.line, {
    x: x1, y, w: x2 - x1, h: 0, line: { color: C.muted, width: 1.5, endArrowType: "triangle" }, objectName: "Arrow",
  });
}

(async () => {
  // ---------------------------------------------------------------- 1 title
  {
    const s = frame(
      1,
      null,
      "Not part of the timed cut. KEEL makes a MUSD position on Mezo something you can hand to someone else. A trove normally belongs to one address and cannot move. KEEL puts it in a vault controlled by an NFT. It is live on Mezo testnet, the link and QR code are on screen, and it is not audited.",
    );
    s.addText("KEEL", { x: 0.6, y: 1.15, w: 5.2, h: 1.1, fontFace: F, fontSize: 72, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Wordmark" });
    s.addText("Tradable MUSD positions on Mezo", { x: 0.6, y: 2.3, w: 5.4, h: 0.6, fontFace: F, fontSize: 24, color: C.muted, margin: 0, isTextBox: true, objectName: "Subtitle" });
    s.addText("A trove inside a vault, controlled by an NFT. Send the NFT, move the position.", {
      x: 0.6, y: 3.0, w: 5.2, h: 0.7, fontFace: F, fontSize: 16, color: C.ink, margin: 0, isTextBox: true, objectName: "Tagline",
    });
    s.addText("keel-two-roan.vercel.app", {
      x: 0.6, y: 3.9, w: 5.2, h: 0.4, fontFace: F, fontSize: 18, bold: true, color: C.accent, margin: 0, isTextBox: true,
      hyperlink: { url: LIVE, tooltip: "KEEL live app" }, objectName: "Live link",
    });
    chip(s, "Testnet. Not audited.", 0.6, 4.45, 2.1, "amber");

    const qr = await QRCode.toBuffer(LIVE, { errorCorrectionLevel: "M", margin: 1, width: 640, color: { dark: "#172033", light: "#FFFFFF" } });
    fs.writeFileSync(IMG("qr-live-app.png"), qr);
    card(s, 6.45, 1.0, 2.95, 3.45, C.white, "QR card");
    s.addImage({ path: IMG("qr-live-app.png"), x: 6.75, y: 1.25, w: 2.35, h: 2.35, altText: "QR code linking to the live KEEL app", objectName: "QR code" });
    s.addText("Open the live app", { x: 6.45, y: 3.75, w: 2.95, h: 0.5, fontFace: F, fontSize: 14, bold: true, color: C.ink, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: "QR caption" });
  }

  // ---------------------------------------------------------------- 2 problem
  {
    const s = frame(
      2,
      "A MUSD trove is stuck to one address",
      "[0:00 to 0:12] A MUSD trove belongs to one address and can't move. To hand a position over, you repay, close, and reopen at today's rate, and you pay the opening fee again.",
    );
    const steps = ["Repay all the debt", "Close the trove", "Open a new trove", "At today's rate"];
    const w = 1.95, gap = 0.33, y = 1.7;
    steps.forEach((t, i) => {
      const x = 0.6 + i * (w + gap);
      card(s, x, y, w, 1.5);
      num(s, i + 1, x + 0.2, y + 0.2);
      s.addText(t, { x: x + 0.2, y: y + 0.7, w: w - 0.4, h: 0.65, fontFace: F, fontSize: 16, bold: true, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: `Step ${i + 1}` });
      if (i < steps.length - 1) arrow(s, x + w + 0.04, y + 0.75, x + w + gap - 0.04);
    });
    card(s, 0.6, 3.6, 8.8, 0.85, C.redT, "Cost");
    s.addText("The locked rate is lost. The opening fee is paid again.", {
      x: 0.85, y: 3.6, w: 8.3, h: 0.85, fontFace: F, fontSize: 18, bold: true, color: C.redText, margin: 0, valign: "middle", isTextBox: true, objectName: "Cost text",
    });
  }

  // ---------------------------------------------------------------- 3 insight
  {
    const s = frame(
      3,
      "A low fixed rate is worth something",
      "[0:12 to 0:24] Each trove's interest rate is fixed when it opens, and the market rate can move later. The gap is real value, but it can't be moved or priced today.",
    );
    const cols = [
      ["Fixed at open", "Each trove keeps the rate it opened at."],
      ["Market moves", "Governance changes the global rate, with a 7 day delay."],
      ["The gap has value", "Today it cannot be moved or priced."],
    ];
    const w = 2.75, gap = 0.275;
    cols.forEach(([h, b], i) => {
      const x = 0.6 + i * (w + gap);
      card(s, x, 1.55, w, 2.55, i === 2 ? C.white : C.card);
      num(s, i + 1, x + 0.25, 1.8);
      s.addText(h, { x: x + 0.25, y: 2.3, w: w - 0.5, h: 0.8, fontFace: F, fontSize: 18, bold: true, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: `Head ${i + 1}` });
      s.addText(b, { x: x + 0.25, y: 3.15, w: w - 0.5, h: 0.85, fontFace: F, fontSize: 15, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Body ${i + 1}` });
    });
  }

  // ---------------------------------------------------------------- 4 solution
  {
    const s = frame(
      4,
      "A vault holds the trove. An NFT holds the vault.",
      "[0:24 to 0:42] KEEL opens each trove from a vault contract and puts the vault under an NFT. The vault asks the NFT who owns it on every call, so there is no stored owner to update. Send the NFT and the whole position moves.",
    );
    card(s, 0.6, 1.35, 4.9, 3.6, C.bg, "Diagram frame");
    s.addImage({ path: IMG("architecture.png"), ...fit(IMG("architecture.png"), 0.75, 1.45, 4.6, 3.4), altText: "Architecture: holder, factory, vault, NFT and the Mezo MUSD core", objectName: "Architecture" });
    const pts = [
      ["Vault is the borrower", "One trove per vault."],
      ["The NFT owns the vault", "ownerOf is read on every holder call."],
      ["Transfer the NFT", "Collateral, debt and locked rate move together."],
    ];
    pts.forEach(([h, b], i) => {
      const y = 1.4 + i * 1.2;
      num(s, i + 1, 5.85, y + 0.02);
      s.addText(h, { x: 6.35, y, w: 3.05, h: 0.4, fontFace: F, fontSize: 16, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: `Point ${i + 1}` });
      s.addText(b, { x: 6.35, y: y + 0.4, w: 3.05, h: 0.6, fontFace: F, fontSize: 13, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Point body ${i + 1}` });
    });
  }

  // ---------------------------------------------------------------- 5 proof
  {
    const s = frame(
      5,
      "Proven live on Mezo testnet",
      "[0:42 to 1:02] Here it is live on Mezo testnet. I sent position two to a second address. The old holder's call reverts with NotHolder. The same call from the new holder succeeds. Both transactions are on the explorer, and the hashes are on screen.",
    );
    card(s, 0.6, 1.3, 4.3, 1.75, C.redT, "Old holder card");
    s.addText("Old holder", { x: 0.85, y: 1.42, w: 3.8, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.muted, margin: 0, isTextBox: true, objectName: "Old holder" });
    s.addText("Vault call reverts", { x: 0.85, y: 1.8, w: 3.8, h: 0.45, fontFace: F, fontSize: 20, bold: true, color: C.redText, margin: 0, isTextBox: true, objectName: "Old result" });
    s.addText("NotHolder  (0x7623fb52)", { x: 0.85, y: 2.3, w: 3.8, h: 0.35, fontFace: MONO, fontSize: 13, color: C.ink, margin: 0, isTextBox: true, objectName: "Old detail" });
    card(s, 5.1, 1.3, 4.3, 1.75, C.greenT, "New holder card");
    s.addText("New holder", { x: 5.35, y: 1.42, w: 3.8, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.muted, margin: 0, isTextBox: true, objectName: "New holder" });
    s.addText("Same call succeeds", { x: 5.35, y: 1.8, w: 3.8, h: 0.45, fontFace: F, fontSize: 20, bold: true, color: C.greenText, margin: 0, isTextBox: true, objectName: "New result" });
    s.addText("Full control. Transfer epoch 2.", { x: 5.35, y: 2.3, w: 3.8, h: 0.35, fontFace: F, fontSize: 13, color: C.ink, margin: 0, isTextBox: true, objectName: "New detail" });

    card(s, 0.6, 3.25, 8.8, 1.7, C.white, "Tx card");
    s.addText("Transfer out, position #2", { x: 0.85, y: 3.35, w: 8.3, h: 0.3, fontFace: F, fontSize: 12, bold: true, color: C.muted, margin: 0, isTextBox: true, objectName: "Tx 1 label" });
    s.addText("0x8f6333d4d33da8081ce25d064f4b9349216bf52ff0e247882c75614c157e0299", {
      x: 0.85, y: 3.65, w: 8.3, h: 0.3, fontFace: MONO, fontSize: 10.5, color: C.ink, margin: 0, isTextBox: true,
      hyperlink: { url: "https://explorer.test.mezo.org/tx/0x8f6333d4d33da8081ce25d064f4b9349216bf52ff0e247882c75614c157e0299" }, objectName: "Tx 1",
    });
    s.addText("Transfer back", { x: 0.85, y: 4.1, w: 8.3, h: 0.3, fontFace: F, fontSize: 12, bold: true, color: C.muted, margin: 0, isTextBox: true, objectName: "Tx 2 label" });
    s.addText("0xf3bf6eae1f23703eb5163d088f373e11694d36debe39392ffd94b510a40a2266", {
      x: 0.85, y: 4.4, w: 8.3, h: 0.3, fontFace: MONO, fontSize: 10.5, color: C.ink, margin: 0, isTextBox: true,
      hyperlink: { url: "https://explorer.test.mezo.org/tx/0xf3bf6eae1f23703eb5163d088f373e11694d36debe39392ffd94b510a40a2266" }, objectName: "Tx 2",
    });
  }

  // ---------------------------------------------------------------- 6 product
  {
    const s = frame(
      6,
      "The product, live",
      "[1:02 to 1:22] This is the live app. The gauge shows the collateral ratio next to the locked and market rates, and the redemption buffer on demand. You open a position from a form, and transfer it through a review step that shows ratio and equity first.",
    );
    const items = [
      ["app-positions.png", 2.4, "Position #1: ratio gauge, locked and market rate (live)"],
      ["app-open.png", 3.4, "Open flow, as a visitor without a wallet sees it (live)"],
      ["explorer-transfer.png", 2.6, "The transfer of position #2 on the Mezo testnet explorer"],
    ];
    let x = 0.6;
    items.forEach(([file, w, cap], i) => {
      card(s, x, 1.25, w, 3.85, C.white, `Frame ${i + 1}`);
      s.addImage({ path: IMG(file), ...fit(IMG(file), x + 0.12, 1.37, w - 0.24, 2.95), altText: cap, objectName: `Screenshot ${i + 1}` });
      s.addText(cap, { x: x + 0.12, y: 4.4, w: w - 0.24, h: 0.62, fontFace: F, fontSize: 11, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Caption ${i + 1}` });
      x += w + 0.2;
    });
  }

  // ---------------------------------------------------------------- 7 MUSD depth
  {
    const s = frame(
      7,
      "Built on the real MUSD contracts",
      "[1:22 to 1:46] It runs on the real MUSD contracts. The vault is the trove's borrower. Mezo's own refinance can raise your rate, so the wrapper only allows a lower one. Reads use getEntireDebtAndColl, so interest and redistribution are included. Hints are looked up right before sending.",
    );
    const items = [
      ["Real MUSD contracts", "Tested at a pinned commit."],
      ["Vault is the borrower", "One trove per vault."],
      ["Safe refinance", "Mezo's can raise your rate."],
      ["Complete debt reads", "Interest and redistribution included."],
      ["Sorted-list hints", "Looked up before sending."],
      ["Redemption buffer", "MUSD ahead of your trove."],
    ];
    const w = 2.8, h = 1.6, gx = 0.2, gy = 0.2;
    items.forEach(([hd, b], i) => {
      const x = 0.6 + (i % 3) * (w + gx);
      const y = 1.3 + Math.floor(i / 3) * (h + gy);
      card(s, x, y, w, h);
      num(s, i + 1, x + 0.2, y + 0.18);
      s.addText(hd, { x: x + 0.2, y: y + 0.62, w: w - 0.4, h: 0.4, fontFace: F, fontSize: 15, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: `Item ${i + 1}` });
      s.addText(b, { x: x + 0.2, y: y + 1.02, w: w - 0.4, h: 0.5, fontFace: F, fontSize: 12, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Item body ${i + 1}` });
    });
    s.addText("Wallets connect through Mezo Passport.", { x: 0.6, y: 4.8, w: 8.8, h: 0.3, fontFace: F, fontSize: 12, color: C.muted, margin: 0, isTextBox: true, objectName: "Passport note" });
  }

  // ---------------------------------------------------------------- 8 security
  {
    const s = frame(
      8,
      "Tested hard. Not audited.",
      `[1:46 to 2:00] ${FACTS.forgeTests} Foundry tests, ${FACTS.invariants} invariants and a state-machine fuzz run against the real MUSD contracts. Three broken vaults were each caught. It is testnet only and not audited.`,
    );
    const stats = [
      [String(FACTS.forgeTests), "Foundry tests"],
      [String(FACTS.invariants), "invariant tests"],
      [String(FACTS.threats), "threats modelled"],
      [String(FACTS.webTests), "web tests"],
      [FACTS.brokenVaults.replace(" of ", "/"), "broken vaults caught"],
    ];
    const sw = 1.64, sg = 0.15;
    stats.forEach(([n, l], i) => {
      const x = 0.6 + i * (sw + sg);
      card(s, x, 1.25, sw, 1.2, C.white, `Stat ${i + 1}`);
      s.addText(n, { x, y: 1.3, w: sw, h: 0.65, fontFace: F, fontSize: 34, bold: true, color: C.ink, align: "center", valign: "middle", margin: 0, isTextBox: true, objectName: `Stat number ${i + 1}` });
      s.addText(l, { x, y: 1.95, w: sw, h: 0.4, fontFace: F, fontSize: 11, color: C.muted, align: "center", valign: "top", margin: 0, isTextBox: true, objectName: `Stat label ${i + 1}` });
    });
    card(s, 0.6, 2.65, 5.0, 2.3, C.card, "Invariants card");
    s.addText("Five design invariants", { x: 0.85, y: 2.75, w: 4.5, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Invariants title" });
    const inv = [
      "Only the current holder moves funds",
      "No idle funds in a vault",
      "A transfer clears every permission",
      "Payouts go to the caller",
      "Outflow never exceeds collateral",
    ];
    s.addText(inv.map((t, i) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: i < inv.length - 1 } })), {
      x: 0.85, y: 3.15, w: 4.55, h: 1.7, fontFace: F, fontSize: 13, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 4, isTextBox: true, objectName: "Invariants list",
    });
    card(s, 5.8, 2.65, 3.6, 2.3, C.card, "Method card");
    s.addText("How", { x: 6.05, y: 2.75, w: 3.1, h: 0.35, fontFace: F, fontSize: 14, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Method title" });
    const how = ["Real MUSD, only the oracle mocked", "Hostile-holder reentrancy tests", "Fuzz of redemption, liquidation, transfer"];
    s.addText(how.map((t, i) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: i < how.length - 1 } })), {
      x: 6.05, y: 3.15, w: 3.15, h: 1.2, fontFace: F, fontSize: 12.5, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 4, isTextBox: true, objectName: "Method list",
    });
    chip(s, "Not independently audited", 6.05, 4.45, 2.35, "amber");
  }

  // ---------------------------------------------------------------- 9 audience
  {
    const s = frame(
      9,
      "Who it is for",
      "Not part of the timed cut. These are the groups I expect to want transferable positions: teams that hold positions together, funds, OTC desks, Bitcoin holders who borrow MUSD, and builders who want positions as composable assets. These are hypotheses. I have no user or market data yet.",
    );
    const who = [
      ["DAOs and treasuries", "Hand a position between signers."],
      ["Funds", "Move exposure without closing it."],
      ["OTC desks", "Settle a position as one asset."],
      ["Bitcoin holders who borrow MUSD", "Gift or hand over a position."],
      ["Builders", "Positions as composable NFTs."],
    ];
    const w = 2.8, h = 1.45, gx = 0.2, gy = 0.2;
    who.forEach(([hd, b], i) => {
      const x = 0.6 + (i % 3) * (w + gx);
      const y = 1.3 + Math.floor(i / 3) * (h + gy);
      card(s, x, y, w, h);
      s.addText(hd, { x: x + 0.2, y: y + 0.2, w: w - 0.4, h: 0.55, fontFace: F, fontSize: 15, bold: true, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: `Who ${i + 1}` });
      s.addText(b, { x: x + 0.2, y: y + 0.85, w: w - 0.4, h: 0.5, fontFace: F, fontSize: 12.5, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Who body ${i + 1}` });
    });
    card(s, 0.6 + 2 * (w + gx), 1.3 + h + gy, w, h, C.amberT, "Hypothesis card");
    s.addText("Hypotheses, not findings", { x: 0.6 + 2 * (w + gx) + 0.2, y: 1.3 + h + gy + 0.2, w: w - 0.4, h: 0.4, fontFace: F, fontSize: 14, bold: true, color: C.amberText, margin: 0, isTextBox: true, objectName: "Hypothesis title" });
    s.addText("No user or market data yet. This is what to test.", { x: 0.6 + 2 * (w + gx) + 0.2, y: 1.3 + h + gy + 0.65, w: w - 0.4, h: 0.7, fontFace: F, fontSize: 12.5, color: C.ink, margin: 0, valign: "top", isTextBox: true, objectName: "Hypothesis body" });
  }

  // ---------------------------------------------------------------- 10 roadmap
  {
    const s = frame(
      10,
      "What comes next",
      "Not part of the timed cut. Next is a marketplace where the buyer commits to bounds and the sale only settles if the position still matches, targeted by 15 November 2026. Then a guardian with on-chain policy bounds. Before any mainnet use, an independent audit. The later items are targets, not commitments.",
    );
    const ms = [
      ["Marketplace", "Target: by 15 Nov 2026", "Buyer commits to bounds. The sale settles only if the position still matches."],
      ["Guardian", "Target: after marketplace", "Owner-set on-chain limits. Anyone can run it."],
      ["Independent audit", "Before any mainnet use", "No mainnet until it is done."],
    ];
    const w = 2.8, gap = 0.2;
    ms.forEach(([h, t, b], i) => {
      const x = 0.6 + i * (w + gap);
      card(s, x, 1.3, w, 3.1, i === 0 ? C.white : C.card);
      num(s, i + 1, x + 0.25, 1.55);
      s.addText(h, { x: x + 0.25, y: 2.1, w: w - 0.5, h: 0.45, fontFace: F, fontSize: 19, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: `Milestone ${i + 1}` });
      chip(s, t, x + 0.25, 2.65, w - 0.5, "amber");
      s.addText(b, { x: x + 0.25, y: 3.1, w: w - 0.5, h: 1.6, fontFace: F, fontSize: 13, color: C.muted, margin: 0, valign: "top", isTextBox: true, objectName: `Milestone body ${i + 1}` });
    });
  }

  // ---------------------------------------------------------------- 11 team and links
  {
    const s = frame(
      11,
      "Team and links",
      "Not part of the timed cut. Names, roles and links are on screen. The code, the live app, the deployments and the threat model are all public, and everything here is testnet only.",
    );
    card(s, 0.6, 1.3, 4.3, 3.65, C.card, "Team card");
    s.addText("Team", { x: 0.85, y: 1.42, w: 3.8, h: 0.4, fontFace: F, fontSize: 18, bold: true, color: C.ink, margin: 0, isTextBox: true, objectName: "Team title" });
    const team = [
      ["[Name]", "[Role]", "[X or LinkedIn]"],
      ["[Name]", "[Role]", "[X or LinkedIn]"],
      ["[Name]", "[Role]", "[X or LinkedIn]"],
    ];
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
      ["Deployments", "docs/DEPLOYMENTS.md", `${REPO}/blob/main/docs/DEPLOYMENTS.md`],
      ["Threat model", "docs/THREAT_MODEL.md", `${REPO}/blob/main/docs/THREAT_MODEL.md`],
    ];
    links.forEach(([l, t, url], i) => {
      const y = 2.0 + i * 0.7;
      s.addText(l, { x: 5.35, y, w: 3.8, h: 0.28, fontFace: F, fontSize: 12, bold: true, color: C.muted, margin: 0, isTextBox: true, objectName: `Link label ${i + 1}` });
      s.addText(t, { x: 5.35, y: y + 0.27, w: 3.8, h: 0.3, fontFace: F, fontSize: 13.5, color: C.accent, margin: 0, isTextBox: true, hyperlink: { url }, objectName: `Link ${i + 1}` });
    });
  }

  await pres.writeFile({ fileName: path.join(ROOT, "keel-deck.pptx") });
  console.log("written", path.join(ROOT, "keel-deck.pptx"));
})();
