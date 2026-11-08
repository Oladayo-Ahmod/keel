# Video script

Target **1:55**. Hard maximum **2:15**. Narration is spoken at about 125 words a minute, so the six scenes below (about 240 spoken words, not counting the optional clip) land at about 1:55 with the pauses. Read it aloud once with a timer before recording and cut to fit.

What is on screen comes from three places, and each scene says which:

- [ROUNDTRIP.md](../ROUNDTRIP.md) and [PROOF.md](../PROOF.md): the flows that ran on Mezo testnet (listing, purchase, transfer, the keeper's transaction, the refusals).
- [features-e2e.json](../features-e2e.json) and `docs/features-e2e/`: the test-wallet run of 2026-11-07 that drove the real sell panel (the price estimate) and the what-if simulator on the live position, and the share page.
- The pages `/proof`, `/break-it` and `/stats`, which show what those documents record.

Nothing is shown that those documents list as not run.

## Read this before recording

- **Scene 3 is live by choice, and has a still fallback.** On 2026-11-08 the second wallet was funded with 300 MUSD (it now holds 384.33), so the 100 MUSD listing, the purchase and the transfer back can be recorded live: see [the rehearsal checklist](#rehearsal-checklist-for-a-live-recording). Whatever is shown must carry its real label: a caption that says "recorded run" and the date for stills, nothing for a live take. Do not present a still as live. The fallback rules are in [When to fall back to stills](#6-when-to-fall-back-to-stills).
- **The keeper's transaction in scene 4 is always a recorded run.** The testnet oracle cannot be moved, so the proof run set the floor above the ratio (PROOF.md, notes). The what-if simulator in the same scene is read only and can be live.
- **Never show or say:** open a position, close a position, refinance, claim surplus or sweep BTC through the app. ROUNDTRIP.md lists all of them as not run. Do not say "audited". Do not call 100 MUSD a fair price: the estimate on screen says about 1,354 MUSD, and 100 is a demo price chosen to keep the test balances small. Do not describe the stats page as adoption, and do not describe the keeper's action as a response to a price crash.
- **Deploy first.** Scenes 2, 3 and 5 show the merged app, which needs `NEXT_PUBLIC_WAVE2=1` for the "Market and guardian positions" section and has the price estimate, the simulator and `/stats`. On 2026-11-08 the live site did not yet have `/stats`, so it had not been redeployed. Open the live site and check each of those exists before recording; if one does not, record from a local build and say nothing about it being the hosted site.
- **Wallet addresses on screen** are the two testnet wallets in PROOF.md. No key, seed phrase or `.env` is ever on screen.
- Record the app at a desktop window about 1280 wide and use the 390 px stills as they are, with a plain background around them. Hide browser bookmarks and notifications.

## Scenes

| Scene | Time | Seconds |
|---|---|---|
| 1. Hook | 0:00 to 0:10 | 10 |
| 2. The position | 0:10 to 0:22 | 12 |
| 3. List, buy, hand over | 0:22 to 1:00 | 38 |
| 4. The guardian | 1:00 to 1:25 | 25 |
| 5. It is all public | 1:25 to 1:40 | 15 |
| 6. What it is today | 1:40 to 1:55 | 15 |

Captions are text laid over the picture, plain white on a dark bar at the bottom, one line, shown for the whole clip. They are listed in each scene.

### Scene 1: hook (0:00 to 0:10)

**On screen.** Slide 2 of the deck (`web/public/trozu-deck.pdf`, "Two things a MUSD trove cannot do"), full screen. No cursor. Hold for the whole scene.

**Caption.** "Mezo testnet. Not audited."

> A MUSD trove can't change hands, and redemptions hit the lowest ratios first. Trozu puts the trove in an NFT, so it can be sold, handed over, or guarded.

### Scene 2: the position (0:10 to 0:22)

**On screen.**
1. Open the live app at https://keel-two-roan.vercel.app/ with the deployer wallet connected. The header shows "Mezo Testnet" and the block number.
2. In the section "Market and guardian positions", scroll to the card "Position #1". Stop where the gauge, the collateral, debt, equity and BTC price, and the locked-versus-market rate bars are all in view.
3. Move the cursor slowly over the gauge, then the two rate bars. Do not click anything that sends a transaction.

**Caption.** "Position 1, live on Mezo testnet"

> This is position one on Mezo testnet: its ratio, its locked rate against the market, its collateral and debt. Move the NFT and all of it moves.

*Source:* PROOF.md step 2 (position opened through the factory, token 1). The card is the app's position view.

### Scene 3: list, buy, hand over (0:22 to 1:00)

**On screen** (live, see the checklist; the fallback is stills):
1. Deployer, "Sell" panel on Position #1, "List for sale". The "Price estimate" box appears with its inputs: equity, the guardian reserve, locked rate 1.00%, market rate 1.00%, rate advantage "none", and a suggested price. Hold on it about 5 seconds. Do not press "Use as price". (Fallback still: `docs/features-e2e/price-hint-390.png`, from the test-wallet run on the live position.) **Caption:** "The estimate shows its inputs. No rate premium: the rates match."
2. Type 100 in "Price (MUSD)". Point at the note that you receive 99.75 MUSD after the 0.25 fee. Sign and list. **Caption:** "Demo price: 100 MUSD. The estimate says about 1,354."
3. Switch to the second wallet. Market, Browse, the 100.00 MUSD card, "Buy", the review step with the bounds, "Buy position", "The position is yours." (Fallback stills: `list-fixed-100-success.jpg`, `buy-review.jpg`, `buy-success.jpg` from `docs/roundtrip/`, hashes `0x84a7743f…6f7c` and `0xf32de59b…5855` as text overlays.) **Caption:** "Buyer's bounds checked in the same transaction."
4. Second wallet, "Transfer" to the deployer, type the last four characters, "Transfer position". (Fallback still: `transfer-back-success.jpg`, hash `0x7d311c24…576f`.) **Caption:** "The new holder sends it back."

If time is short, cut to the explorer page for the purchase, tx `0xf32de59bc28e9382785130b209770dc65f2a5f2d8883b36fc5285cad70535855`.

> To sell, the holder lists it. The app shows an estimate with its inputs: equity, and no rate premium, because the rates match. For the demo we list at 100 MUSD. The buyer sets bounds on collateral, debt, rate and reserve. One transaction checks them, pays the seller and the fee, and moves the NFT. Then the new holder sends it back.

*Source:* ROUNDTRIP.md ("List fixed price 100 MUSD", "Second wallet buys the 100 MUSD listing (permit)", "Second wallet transfers the position back"); the estimate from `docs/features-e2e.json`.

### Scene 4: the guardian (1:00 to 1:25)

**On screen.**
1. Deployer, Position #1, the "What if" section. Press "Check buffer to enable", then drag "BTC price" to about -45% and "Redemption pressure" to about 120%. The result shows the ratio falling, "Liquidatable", the guardian's line, and "Model, not a prediction". Read only: nothing is sent. (Fallback still: `docs/features-e2e/what-if-390.png`.) About 10 seconds. **Caption:** "A model, not a prediction."
2. Cut to the explorer page for the keeper's top-up, tx `0x7d2280786535e8ce51456007e12073906266a3afc39a8e6341ac90763a309335` (PROOF.md step 18). About 7 seconds. **Caption:** "Recorded on Mezo testnet, 2026-11-06"
3. The proof page claim "keeper-floor" (https://keel-two-roan.vercel.app/proof): "ratio 135.07% to 145.17%, tip 0.00001 BTC". About 6 seconds.

> The guardian. The holder funds a reserve and sets a floor. The what-if simulator shows what it would do if the price fell, and says it is a model, not a prediction. Here is the real thing, recorded: a keeper lifted this position from 135 to 145 percent. The testnet price can't move, so we set the floor above the ratio.

*Source:* the simulator from `docs/features-e2e.json`; the keeper's action from PROOF.md step 18 and the notes on the oracle.

### Scene 5: it is all public (1:25 to 1:40)

**On screen.**
1. https://keel-two-roan.vercel.app/proof, scrolled slowly through the claims. About 5 seconds. Stop on the two claims marked Open.
2. https://keel-two-roan.vercel.app/break-it, top of the page with the first entries. About 5 seconds.
3. https://keel-two-roan.vercel.app/stats, the banner at the top ("All activity so far was run by the team on testnet…") and the tile "Addresses other than the team's". About 5 seconds. **Caption:** "All activity so far: the team's own wallets."

> Everything is public. The proof page ties each claim to a transaction, the break-it page lists the attacks that worked, and the stats page shows all activity so far is ours.

*Source of the content:* these pages render `web/src/content/proof.json` and `break-it.json` (taken from PROOF.md and REVIEW.md) and read the chain's event logs. Check on the day that the stats banner really says the activity is all the team's: it only does while the tile "Addresses other than the team's" reads 0. If someone else has used the contracts, say what the page says instead. Check the live site shows the version with the two later findings on `/break-it` (it did not on 2026-11-08, because the merged app had not been deployed). If it does not, cut that clip.

### Scene 6: what it is today (1:40 to 1:55)

**On screen.**
1. Slide 3 of the deck, "What the chain says", for about 8 seconds.
2. Slide 1, with the QR code and "keel-two-roan.vercel.app" and the chip "Testnet. Not audited.", for the last 7 seconds. Leave it up until the narration ends.

**Caption.** "Testnet only. Not audited. keel-two-roan.vercel.app"

> It's testnet only and not audited. On mainnet there are three troves and the rate has never moved, so revenue today is zero. Try it at keel-two-roan.vercel.app.

## Optional: 10-second MCP clip (leave out unless the condition is met)

**Condition.** Only record this if Claude Desktop or Claude Code is actually shown loading the `@trozu/mcp` server from the config in `packages/mcp/examples/claude_desktop_config.json`, with the server listed as connected and one read-only tool call answering from live testnet data. As of 2026-11-08 that has **not** been done: `packages/mcp/README.md` says only the stdio handshake was tested, not a real client, so this clip is **not** part of the script. If it is recorded later it goes between scenes 4 and 5 and needs 10 seconds taken from scene 5 or from the pauses.

**On screen, if the condition is met.**
1. The client's settings or tools list showing `trozu` connected (no key anywhere on screen).
2. One question typed in the client, for example "What is the ratio of Trozu position 1?", and the tool call and answer.

> Claude can read positions through a read-only tool. It can't sign or send anything.

## Rehearsal checklist for a live recording

For scene 3 (and the read-only simulator in scene 4). A live run changes the position, so rehearse it once off camera, restore the staged state, then record.

### State to start from (read on 2026-11-08)

| | |
|---|---|
| Position | 1, vault `0x2B08BB7F73beD0FA0454907a7E7082F1a58d9AB9`, held by the deployer `0x5104C1A6…8F98`, transfer epoch 9, about 0.0432 BTC against 2,010.90 MUSD |
| Deployer wallet | 3,322.03 MUSD, 0.00859 BTC |
| Second wallet (the buyer) `0xf8B5CF02…EdEe2` | 384.33 MUSD, 0.002 BTC. Funded on 2026-11-08 with 300 MUSD, tx `0x0fd99d02b7c7cc6a67c81f37e72e088b0d1cde97cfc9678c9e001fc329a9d447` |
| Staged listings (both `Ok`, epoch 9) | a fixed 6,000 MUSD listing, and a Dutch auction from 9,000 falling to 5,000 MUSD, open about 30 days |
| Guardian policy (live) | floor 130%, target 160%, largest BTC action 0.008643 BTC, largest MUSD action 402.17, period caps 0.017287 BTC and 804.34 MUSD, tip 0.00005 BTC, period 24 hours, redemption defense off. Reserve 0.001188 BTC |

The two wallets must both have more than 0.001 BTC for gas before and after. A transaction here costs about 0.00000000015 BTC, so a few takes are nothing. Check balances before every take.

**What a live run does to that state.** The buy moves the NFT to the second wallet, and the transfer back moves it again, so the transfer epoch goes from 9 to 11. That kills both staged listings (`StaleEpoch`) and the guardian policy (`PolicyStale`), and clears the market's approval on the token. The reserve is untouched. Restore it all afterwards (below).

### 1. Before the take

1. The merged app is deployed with `NEXT_PUBLIC_WAVE2=1` (see "Deploy first" above).
2. Both wallets are imported into the browser wallet you will record with. No key, seed phrase or `.env` is ever on screen.
3. Balances as in the table, or better. The second wallet needs at least 100 MUSD: the buyer pays the listed price, 100.00, and the 0.25 fee comes out of it, not on top.
4. Nothing is pending on either wallet (check the explorer).

### 2. The listing (deployer)

1. Connect the deployer. Open "Position #1" under "Market and guardian positions". In the "Sell" panel press "List for sale".
2. The "Price estimate" box appears. Check it before the take: it should show the equity (about 1,264 MUSD at the testnet price on 2026-11-07, so it moves), the guardian reserve, the two rates both 1.00%, the rate advantage "none", and a suggested price of about 1,354 MUSD. Hold on it for the narration. Do not press "Use as price".
3. Choose **Fixed price**. Type **100** in "Price (MUSD)". Leave "Listing stays open (days)" at 7.
4. The note under the price should read that you receive 99.75 MUSD after the market's 0.25% fee of 0.25. That is the number to point at.
5. Press "Sign and list". If the panel says it will first approve the market on this one NFT (it will, because the transfer cleared the approval), approve in the wallet first. Then sign the listing (a typed-data signature, no gas), then confirm the announce transaction. The panel says "Listed. It now shows in the market."
6. In the ROUNDTRIP run this was `announce` for 100 MUSD (`0x84a7743f…6f7c`).

### 3. The purchase (second wallet)

1. Switch the browser wallet to the second wallet and reload. Open the Market tab, Browse. The 100 MUSD card ("Position #1", "Fixed price", the "Demo listing" chip) is among the cards. The staged 6,000 and Dutch listings are also there. Press "Buy" on the 100.00 MUSD one.
2. The review step shows the price (100.00 MUSD), the fee and the bounds taken from what was on screen. Read the bounds aloud only if the narration has room.
3. Press "Buy position". The wallet asks for a permit signature (no gas) and then the buy transaction. If the permit cannot be used the app asks for an approval transaction first. The panel ends with "The position is yours." and the hash. In the ROUNDTRIP run this was `0xf32de59b…5855`.
4. The listing leaves Browse. Under "Positions" the second wallet now shows "Position #1", "Held by you".

### 4. The transfer back (second wallet)

1. On the card press "Transfer". The first step shows the ratio and equity: press "Continue".
2. Paste the deployer address `0x5104C1A69242D94159Cf7151277252e568cB8F98` as the receiver and press "Continue". The app asks you to type the last four characters of the address: type `8F98`, then press "Transfer position" and confirm in the wallet. The card leaves the second wallet's list. In the ROUNDTRIP run this was `safeTransferFrom` (`0x7d311c24…576f`).
3. Switch to the deployer: "Position #1" is "Held by you" again.

### 5. Restore the staged demo state (deployer, after every take)

Do all four. The numbers are the ones the staging used (ROUNDTRIP.md).

1. **Dutch auction.** Sell panel, "Dutch auction". Starting price **9000**, lowest price **5000**, falls over **720** hours (30 days), listing stays open **30** days. Approve the market first if asked. Sign and list. (With equal rates the price estimate says an auction has no range here. Ignore that; the form still accepts the prices you type.)
2. **Fixed price.** Sell panel, "Fixed price", price **6000**, open **30** days. Sign and list.
3. **Guardian policy.** Guardian panel, Policy tab. Press "Suggest from my position", which fills the values in the table above (act under 130%, restore to 160%, a fifth of the position per action, two fifths per period, tip 0.00005 BTC, period 24 hours) from the position's current collateral and debt, and check redemption defense is off. Press "Save policy". The reserve (0.001188 BTC) is still there.
4. **Check.** Market, Browse shows 2 listings. `/stats` shows active listings of 2, both demo. The guardian panel says the policy is live. If either listing says it cannot settle, the token's approval is missing: list again and approve when asked.

Each rehearsal and each take adds 2 to the epoch, so the epoch number in the table will move. That is expected.

### 6. When to fall back to stills

Keep scene 3 as the stills named in it **only if** the live run proves unreliable. Call it unreliable if any of these happens in two takes in a row:

- A step fails or the app says the node did not answer (the public RPC drops requests now and then). The app's own message says to check the explorer before retrying: do, and do not send twice.
- The purchase or the transfer takes long enough that the scene needs more than about 40 seconds of dead time to cut.
- The restore in section 5 does not bring the market back to 2 listings.

If you fall back, use the stills named in the scene and the "recorded run" caption, and say so in the first line of the video description.

**Stays recorded in every case:**

- **The keeper's transaction in scene 4.** The testnet oracle cannot be moved, so a keeper action can only be provoked by setting the policy floor above the position's current ratio and then running the keeper with its key. That is what the proof run did, and it is not something to do live on camera. The explorer page for PROOF.md step 18 is the footage.

**Can be live, read only:** scene 2 (the card), the price estimate in scene 3 (it only reads), and the what-if simulator in scene 4 (no transaction). If any of these misbehaves, use the stills named in the scene.

Because a live take of scene 3 is longer than its 38 seconds of narration, record it, then cut it down to the estimate, the listing, the review step, the success and the transfer.

## What to cut if the first take is over 2:15

In this order: the explorer page in scene 3 (4 seconds), the proof-page clip in scene 4 (6 seconds), the `/break-it` clip in scene 5 (5 seconds). Do not cut the closing line in scene 6.

## Checks before publishing

- Run `python3 script/check_links.py` and make sure every link on screen, including the video URL once it exists, answers 200 logged out.
- Every hash on screen is copied from PROOF.md or ROUNDTRIP.md, not retyped.
- Say "testnet" in the first and last scenes.
