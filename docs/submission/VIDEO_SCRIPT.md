# Video script

Target **2:00**. Hard maximum **2:15**. Narration is spoken at about 135 words a minute, so the seven scenes below (273 spoken words, not counting the optional clip) land at about two minutes with the pauses. Read it aloud once with a timer before recording and cut to fit.

Everything on screen comes from a flow that [ROUNDTRIP.md](../ROUNDTRIP.md) or [PROOF.md](../PROOF.md) records as having run on Mezo testnet. Nothing is shown that those two documents list as not run.

## Read this before recording

- **Most of the sales and guardian footage is a recorded run, not a live one.** The wallet round trip (2026-11-07) ran the app's own screens at 390 px and saved a screenshot at each step in `docs/roundtrip/`. The live proof run (2026-11-06) is a script and shows as transactions on the explorer. A live repeat of the 100 MUSD purchase is not possible with the current balances (the second wallet holds 84.33 MUSD). So scenes 3, 4 and 5 show stills and explorer pages, with a caption that says "recorded run" and the date. Do not present them as live.
- **Never show or say:** open a position, close a position, refinance, claim surplus or sweep BTC through the app. ROUNDTRIP.md lists all of them as not run. Do not say "audited", do not mention users, partners or revenue other than the line in scene 7, and do not describe the proof run's keeper actions as a response to a price crash: the oracle cannot be moved on testnet, so the floor was set above the ratio (PROOF.md, notes).
- **Deploy first.** Scenes 2 and 6 show the merged app, which needs `NEXT_PUBLIC_WAVE2=1` for the "Market and guardian positions" section, and the new proof and break-it content. On 2026-11-07 the live site did not yet have `/stats`, so it had not been redeployed. Open the live site and check scene 2's card and scene 6's pages exist before recording; if they do not, record from a local build and say nothing about it being the hosted site.
- **Wallet addresses on screen** are the two testnet wallets in PROOF.md. No key, seed phrase or `.env` is ever on screen.
- Record the app at a desktop window about 1280 wide for scene 2 and use the 390 px stills as they are, with a plain background around them. Hide browser bookmarks and notifications.

## Scenes

| Scene | Time | Seconds |
|---|---|---|
| 1. The problem | 0:00 to 0:12 | 12 |
| 2. The position | 0:12 to 0:26 | 14 |
| 3. Hand it over | 0:26 to 0:44 | 18 |
| 4. Sell it | 0:44 to 1:10 | 26 |
| 5. The guardian | 1:10 to 1:34 | 24 |
| 6. It is all public | 1:34 to 1:46 | 12 |
| 7. What it is today | 1:46 to 2:00 | 14 |

### Scene 1: the problem (0:00 to 0:12)

**On screen.** Slide 2 of the deck (`web/public/trozu-deck.pdf`, "Two things a MUSD trove cannot do"), full screen. No cursor. Hold for the whole scene.

> On Mezo, a MUSD trove belongs to one address. To hand it over, you close and reopen it. And redemptions hit the lowest-ratio troves first, with no defense.

### Scene 2: the position (0:12 to 0:26)

**On screen.**
1. Open the live app at https://keel-two-roan.vercel.app/ with the deployer wallet connected. The header shows "Mezo Testnet" and the block number.
2. In the section "Market and guardian positions", scroll to the card "Position #1". Stop where the gauge, the collateral, debt, equity and BTC price, and the locked-versus-market rate bars are all in view.
3. Move the cursor slowly over the gauge, then the two rate bars. Do not click anything that sends a transaction.

> Trozu puts the trove in a vault controlled by an NFT. This is position one on Mezo testnet, with its ratio and its locked rate. Move the NFT and the whole position moves.

*Source:* PROOF.md step 2 (position opened through the factory, token 1). The card is the app's position view.

### Scene 3: hand it over (0:26 to 0:44)

**On screen** (recorded run, caption "Recorded on Mezo testnet, 2026-11-06"):
1. Open the explorer page for the transfer to the second wallet, tx `0x5a5f35a22f294e7331b5710bf55f70729d8ca75bb173df159a2269db02076c70` (PROOF.md step 5). Hold about 5 seconds on the transaction and its status.
2. Cut to docs/PROOF.md, section "Refusals". Highlight the rows "the old holder tries to withdraw collateral after the transfer: `NotHolder`" and "a keeper tries the policy that was set before the two transfers: `NothingToDo(PolicyStale)`". Hold about 8 seconds.

> We sent it to a second wallet and back, on chain. The old holder's calls revert with NotHolder. A guardian policy set by the old holder stops applying, so a keeper's call reverts with PolicyStale.

### Scene 4: sell it (0:44 to 1:10)

**On screen** (stills from `docs/roundtrip/`, caption "Recorded run through the app, 2026-11-07, 390 px"; each still about 5 seconds, then the explorer):
1. `list-fixed-100-success.jpg`: the listing of 100 MUSD, with its hash `0x84a7743f…6f7c` as a text overlay (ROUNDTRIP.md, "List fixed price 100 MUSD").
2. `buy-review.jpg`: the buyer's review step.
3. `buy-success.jpg`: the purchase by the second wallet, with its hash `0xf32de59b…5855` as a text overlay (ROUNDTRIP.md, "Second wallet buys the 100 MUSD listing (permit)").
4. The explorer page for the buy transaction `0xf32de59bc28e9382785130b209770dc65f2a5f2d8883b36fc5285cad70535855`, about 4 seconds.
5. docs/PROOF.md "Refusals", the row "buying a listing signed before the position moved away and back: `ListingInvalid(StaleEpoch)`", about 5 seconds.

> To sell, the holder signs a listing at a fixed or falling price. The buyer sets bounds on collateral, debt, rate and reserve. One transaction checks every bound, pays the seller and the fee, and moves the NFT. Here the second wallet buys for 100 MUSD with a signed permit. A listing signed before the position moved is refused.

### Scene 5: the guardian (1:10 to 1:34)

**On screen:**
1. `docs/roundtrip/policy-success.jpg`, caption "Recorded run through the app, 2026-11-07": the policy saved from the app (ROUNDTRIP.md, "Guardian: save a policy", hash `0x661abb34…13c3`). About 6 seconds.
2. Explorer page for the keeper's top-up, tx `0x7d2280786535e8ce51456007e12073906266a3afc39a8e6341ac90763a309335` (PROOF.md step 18), caption "Recorded on Mezo testnet, 2026-11-06". About 6 seconds.
3. The proof page claim "keeper-floor" (https://keel-two-roan.vercel.app/proof), showing "ratio 135.07% to 145.17%, tip 0.00001 BTC". About 6 seconds.
4. docs/PROOF.md "Refusals", the row "a keeper calls execute while the position is inside its policy: `NothingToDo(Healthy)`". About 5 seconds.

> The guardian. The holder funds a reserve and sets a floor. Anyone can trigger it, and it acts only if the vault's planner agrees the policy calls for it. A keeper lifted this position from 135 to 145 percent and earned 0.00001 BTC. The testnet price can't move, so we set the floor above the ratio.

### Scene 6: it is all public (1:34 to 1:46)

**On screen.**
1. https://keel-two-roan.vercel.app/proof, scrolled slowly through the claims list. About 6 seconds. Stop on the two claims marked Open.
2. https://keel-two-roan.vercel.app/break-it, top of the page with the first entries. About 6 seconds.

> Everything is public. The proof page links each claim to its transaction, and the break-it page lists the attacks that worked, including the ones we found ourselves.

*Source of the content:* these two pages render `web/src/content/proof.json` and `break-it.json`, which are taken from PROOF.md and REVIEW.md. They are pages, not ROUNDTRIP or PROOF flows, and they only show what those documents record. Check the live site shows the version with the two later findings before recording (it did not on 2026-11-07, because the merged app had not been deployed). If it does not, cut this scene.

### Scene 7: what it is today (1:46 to 2:00)

**On screen.**
1. Slide 3 of the deck, "What the chain says", for about 8 seconds.
2. Slide 1, with the QR code and "keel-two-roan.vercel.app" and the chip "Testnet. Not audited.", for the last 6 seconds. Leave it up until the narration ends.

> It's testnet only and not audited. On mainnet there are three troves and the rate has never moved, so revenue today is zero. The fee is 25 basis points on sales, paid by the seller.

## Optional: 10-second MCP clip (leave out unless the condition is met)

**Condition.** Only record this if Claude Desktop or Claude Code is actually shown loading the `@trozu/mcp` server from the config in `packages/mcp/examples/claude_desktop_config.json`, with the server listed as connected and one read-only tool call answering from live testnet data. As of 2026-11-07 that has **not** been done: `packages/mcp/README.md` says only the stdio handshake was tested, not a real client, so this clip is **not** part of the script. If it is recorded later it replaces nothing; it goes between scenes 5 and 6 and needs 10 seconds taken from scene 6 or from the pauses.

**On screen, if the condition is met.**
1. The client's settings or tools list showing `trozu` connected (no key anywhere on screen).
2. One question typed in the client, for example "What is the ratio of Trozu position 1?", and the tool call and answer.

> Claude can read positions through a read-only tool. It can't sign or send anything.

## What to cut if the first take is over 2:15

In this order: the explorer page in scene 4 (4 seconds), the third item in scene 5 (6 seconds), scene 6 (12 seconds). Do not cut the closing line in scene 7.

## Checks before publishing

- Run `python3 script/check_links.py` and make sure every link on screen, including the video URL once it exists, answers 200 logged out.
- Every hash on screen is copied from PROOF.md or ROUNDTRIP.md, not retyped.
- Say "testnet" in the first and last scenes.
