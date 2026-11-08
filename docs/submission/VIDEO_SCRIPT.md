# Video script

Target **2:00**. Hard maximum **2:15**. Narration is spoken at about 135 words a minute, so the seven scenes below (273 spoken words, not counting the optional clip) land at about two minutes with the pauses. Read it aloud once with a timer before recording and cut to fit.

Everything on screen comes from a flow that [ROUNDTRIP.md](../ROUNDTRIP.md) or [PROOF.md](../PROOF.md) records as having run on Mezo testnet. Nothing is shown that those two documents list as not run.

## Read this before recording

- **Scenes 3, 4 and 5 are written as recorded footage, with a live option for 3 and 4.** The wallet round trip (2026-11-07) ran the app's own screens at 390 px and saved a screenshot at each step in `docs/roundtrip/`. The live proof run (2026-11-06) is a script and shows as transactions on the explorer. On 2026-11-08 the second wallet was funded with 300 MUSD (it now holds 384.33), so the 100 MUSD purchase and the transfer back can be recorded live: see [the rehearsal checklist](#rehearsal-checklist-for-a-live-recording). Whatever is shown must carry its real label: a caption that says "recorded run" and the date for stills, nothing for a live take. Do not present a still as live. Scene 5 stays stills in every case (the checklist says why).
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

## Rehearsal checklist for a live recording

For scenes 3 and 4 (and the app part of scene 5). A live run changes the position, so rehearse it once off camera, restore the staged state, then record.

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
2. Choose **Fixed price**. Type **100** in "Price (MUSD)". Do not press "Use as price": the estimate suggests about 1,354 MUSD, which is not the sale you are filming. Leave "Listing stays open (days)" at 7.
3. The note under the price should read that you receive 99.75 MUSD after the market's 0.25% fee of 0.25. That is the number to point at.
4. Press "Sign and list". If the panel says it will first approve the market on this one NFT (it will, because the transfer cleared the approval), approve in the wallet first. Then sign the listing (a typed-data signature, no gas), then confirm the announce transaction. The panel says "Listed. It now shows in the market."
5. In the ROUNDTRIP run this was `announce` for 100 MUSD (`0x84a7743f…6f7c`).

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

1. **Dutch auction.** Sell panel, "Dutch auction". Starting price **9000**, lowest price **5000**, falls over **720** hours (30 days), listing stays open **30** days. Approve the market first if asked. Sign and list.
2. **Fixed price.** Sell panel, "Fixed price", price **6000**, open **30** days. Sign and list.
3. **Guardian policy.** Guardian panel, Policy tab. Press "Suggest from my position", which fills the values in the table above (act under 130%, restore to 160%, a fifth of the position per action, two fifths per period, tip 0.00005 BTC, period 24 hours) from the position's current collateral and debt, and check redemption defense is off. Press "Save policy". The reserve (0.001188 BTC) is still there.
4. **Check.** Market, Browse shows 2 listings. `/stats` shows active listings of 2, both demo. The guardian panel says the policy is live. If either listing says it cannot settle, the token's approval is missing: list again and approve when asked.

Each rehearsal and each take adds 2 to the epoch, so the epoch number in the table will move. That is expected.

### 6. When to fall back to stills

Keep scenes 3 and 4 as the stills in the scene list **only if** the live run proves unreliable. Call it unreliable if any of these happens in two takes in a row:

- A step fails or the app says the node did not answer (the public RPC drops requests now and then). The app's own message says to check the explorer before retrying: do, and do not send twice.
- The purchase or the transfer takes long enough that the scene needs more than about 40 seconds of dead time to cut.
- The restore in section 5 does not bring the market back to 2 listings.

If you fall back, use the stills named in the scenes and the "recorded run" caption, and say so in the first line of the video description.

**Stays stills in every case:**

- **Scene 5, the guardian.** The testnet oracle cannot be moved, so a keeper action can only be provoked by setting the policy floor above the position's current ratio and then running the keeper with its key. That is what the proof run did, and it is not something to do live on camera. The policy-save still and the keeper's top-up on the explorer (PROOF.md step 18) are the footage.
- **The refusals** in scenes 3 and 4 (`NotHolder`, `PolicyStale`, `StaleEpoch`). They are `eth_call` results in PROOF.md, not app screens.

**Can be live:** scene 2 (the card), scene 3's transfer (section 4) and scene 4's listing and purchase (sections 2 and 3). Because a live take is longer than the 26 seconds of narration in scene 4, record it, then cut it down to the listing, the review step, the success and the explorer page.

## What to cut if the first take is over 2:15

In this order: the explorer page in scene 4 (4 seconds), the third item in scene 5 (6 seconds), scene 6 (12 seconds). Do not cut the closing line in scene 7.

## Checks before publishing

- Run `python3 script/check_links.py` and make sure every link on screen, including the video URL once it exists, answers 200 logged out.
- Every hash on screen is copied from PROOF.md or ROUNDTRIP.md, not retyped.
- Say "testnet" in the first and last scenes.
