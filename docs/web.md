# Web app: wave 2 work

Area: `web/` only. Test count at this commit: 299 passing in 23 files (`npm test`). Typecheck clean, production build clean (with `NEXT_PUBLIC_SITE_URL` set, see Share cards).

## Position management (wave 1 vault, also used for wave 2 vaults)

`ManagePanel` offers add collateral, withdraw, borrow, repay, refinance, close, claim surplus and sweep on a position the connected wallet holds.

Every action goes through the same steps:
1. A pre-flight read of the wallet and vault (`usePreflight`), paired with a head block so a lagging node is noticed.
2. A pure plan (`lib/manage.ts`) that returns errors, warnings and the resulting ratio. Errors disable the button.
3. A review step that restates what moves.
4. On confirm: `assertFresh()`, sorted-list hints computed at that moment (`needsHints`), a permit signature or an approve transaction where MUSD is pulled, a `simulateContract`, then the send.

Choices worth knowing:
- Refinance shows the locked rate, market rate, drop, fee, yearly saving and break-even days. The saving is computed from the rate drop and principal, not from the Lens `annualSpreadMusd`, whose sign is global minus locked.
- Repay uses a permit when the signing domain hashes to the token's own `DOMAIN_SEPARATOR`, an existing allowance when there is one, and an approve transaction otherwise.
- **Close does not use `closeWithPermit`.** The vault asks for a permit over the exact cost at execution time, and interest changes that cost every second, so a signature made earlier would not match. Close approves 0.1% above the cost and the vault pulls the exact amount.
- Withdraw and borrow refuse a result under 120% (Mezo's own floor is 110%). Recovery Mode blocks withdraw, refinance and close in the plan.
- Sweep on a wave 2 vault excludes the guardian reserve, as the contract does.

Tooltips for trove, collateral ratio, redemption buffer, locked rate, refinance, the 200 MUSD reserve, permit, Recovery Mode and surplus are in `lib/glossary.ts`.

## Market (behind the flag)

Flag: build with `NEXT_PUBLIC_WAVE2=1`. Default is off and nothing wave 2 renders. Addresses come from `src/config/deployment.v2.json` (the same file the keeper reads); `npm run check:deployment` fails if any of them has no code on matsnet.

- Browse: reads `ListingAnnounced` logs in 9,000-block windows from the deployment block, asks `check()` for each listing, attaches `positionInfo` and the vault's reserve.
- Buy: bounds are what was on screen. Debt gets 0.5% headroom for interest, the price cap is the price one minute ago (clock slack), the reserve minimums are pinned. Permit is over `maxPrice`, which is what the market asks the token for.
- Sell: approves the market on the one NFT if needed, signs the EIP-712 listing with the chain's own block time, calls `check()`, then `announce`.
- Your listings: cancel one, or `cancelAll`.
- Dutch chart: `priceAt` mirrored in integer maths; the test pins rounding and monotonicity.

## Guardian (behind the flag)

Policy form validates against every `BadPolicy` revert before sending. Reserve tab funds and withdraws BTC and MUSD and shows the period allowance. History tab reads `GuardianAction` logs on demand. There is no refinance anywhere in the guardian, and the panel says so.


## Price estimate in the sell flow (behind the flag)

`FairPriceHint` sits above the price field in the sell panel. The maths is `lib/fairprice.ts`, a pure function with its own tests.

- Floor: equity (collateral value minus debt, from the lens) plus the guardian reserve at the BTC price. The reserve stays in the vault, so a buyer gets it.
- Premium: principal times the gap between the market rate and the locked rate, for a horizon of one year, at today's market rate. The one-year horizon is an assumption chosen for the estimate, not a market fact; it is printed next to the result.
- Suggested price is floor plus premium, rounded down to a cent. For a Dutch auction the suggestion is a fall from that number to the floor, and only when there is a premium to fall through.
- A gap of zero or less gives no premium, and no discount either (a buyer could refinance). The panel says which case it is.
- No suggestion is shown when the node is stale, the price feed is down, the trove is closed, or equity is zero or negative with nothing else to price.
- Every input is shown. The button copies the number into the field; it never signs or lists anything.


## Live stats: /stats and /api/stats

Both read `getStats()` in `lib/statsServer.ts`, which runs `buildSnapshot` (`lib/statsSnapshot.ts`) against matsnet and keeps the answer for about 60 seconds. The page is rendered per request, so a build never calls the RPC. The API sends `Cache-Control: public, s-maxage=60` (5 seconds while a read is incomplete).

- Positions: factory `PositionCreated`. Listings and sales: market `ListingAnnounced`, `ListingCancelled`, `AllListingsCancelled`, `Sold`. Sale volume and fee collected are the sums of `price` and `fee` in `Sold`. Policies and keeper actions: `PolicySet`, `PolicyCleared`, `GuardianAction`, kept only from vaults the factory created.
- Active listings: announced, minus sold, cancelled, bulk-cancelled and expired, then each remaining one (up to 40) is asked `check()`. Over 40, the log count is shown and marked not exact.
- Refusals: a refused `execute` reverts and leaves no event, so past refusals cannot be counted. The page shows the vault planner's answer right now for up to 25 policies instead, and says so.
- Caps: 9,000-block windows, at most 540,000 blocks per scan (older history is dropped and the page says counts are "since block N"), 6 seconds of reading per request (an unfinished range is flagged and continues on the next load), and each window is retried four times.
- Stale node: the head is judged like every other read (`freshness.ts`), and a window answered by a node whose head is below the window's end is retried. A stale head still shows, with a warning. If the chain cannot be read, the last good snapshot from server memory is shown marked as such, and with none the page shows no numbers.
- Team wallets: the deployer (also the fee recipient from `deployment.v2.json`), the second wallet and the keeper, from `wallets` in `src/content/proof.json` (copied from `docs/proof.json`; a test fails if they drift apart). `config/team.ts` throws if one is missing, so a short list cannot count the team as other people.
- "Addresses other than the team's" is the number of distinct addresses in the logs that are not team wallets: position holders, listing sellers (announced or cancelled), buyers, recipients and keepers. It is always shown, including 0. It sees only what those logs show: someone who only looked at the app, or only moved an NFT, is not counted, and one person with two wallets counts twice.
- A banner on top says what the numbers are. With 0 other addresses it says all activity so far was run by the team on testnet and is test traffic, not user adoption. With more it says the counts include the team's own test activity and are not a measure of adoption, and says how many other addresses appear. Active listings show how many are demo listings, meaning announced by a team wallet.
- The market list marks a listing from a team wallet with a "Demo listing" chip and says above the list that demo listings show the market working and are not user adoption. It only says "all activity here so far was run by the team" when every listing shown is a demo listing (`lib/demo.ts`, tested).
- The page prints when it was updated, the block range and the age of the newest block. The proof page links to it.
- Cross-check: on 2026-11-07 the route's counts (1 position, 10 announced, 2 cancelled, 3 sold, same volume and fee) matched a separate script reading the same logs.


## What-if simulator on the position card

`WhatIf` sits under the redemption buffer on every open position card, owned or not. Two sliders: BTC price from -80% to +50%, and redemption pressure from 0% to 150% of the buffer. The maths is `lib/whatif.ts`.

- It applies the price move, then the redemption, then asks the planner what the guardian would do in the resulting state. The planner is `planGuardian`, a branch-for-branch port of `TrozuVault._plan`. The keeper does not have planner logic of its own: it asks the vault's `preview` and sends `execute` when the kind is not None. `keeperOutcome` mirrors that branch, so the simulator says whether a keeper would send or skip, with the same words (`planner says Healthy`).
- Redemption pressure needs the buffer, so the slider is off until the buffer is checked (the same lens read as the buffer panel, so one check serves both). Pressure under 100% uses up part of the buffer. Over 100% the excess is taken from this trove at the moved price, never touching the 200 MUSD gas compensation. A buffer that is only a lower bound is never shown as reaching the trove.
- Redemption defense is modelled with the policy's floor: under the floor with a complete walk the planner says DefendBtc, otherwise Healthy or BufferUnknown.
- At the top of the panel it says "Model, not a prediction". Below the result it lists what it leaves out: the redemption fee, interest over time, other troves being liquidated (a price move does not change the buffer here), and Recovery Mode (the model uses 110%, the contract may ask for the system ratio).
- Golden vectors: `test/v2/PlannerVectors.t.sol` builds 503 random guardian states on the local MUSD deployment (a position, a redemption queue ahead of it, a reserve, a policy, a spent allowance and window, a price move and elapsed time), asks the vault's own `preview()`, and writes state and answer to `src/lib/__fixtures__/planner-vectors.json`. It aims modes at each branch (below minimum, reserve-bound, period-bound, action-cap-bound, minimum-debt-bound, tip paid, tip dust, tip reserve-short, redemption verdicts Above, Below and Unknown, healthy hold, no policy, stale, closed trove, Recovery Mode) and fails if any is never reached. The generation is deterministic, CI fails if the committed file is stale, and `whatif.test.ts` replays every vector against `planGuardian`. **First run, against the port as first written: 81 of 503 differed.** 60 were Recovery Mode, where the contract asks an action to reach the system ratio and the port used 110%. 21 were redemption defense, where the policy's walk is shorter than the buffer reading and the port said Healthy where the contract said Unknown. Fixed by making the minimum ratio an input and by working the verdict out as the contract does (`verdictFrom`: exact except one case it reports, where it assumes the cautious Unknown). Amounts, tips, ratios and the window reset matched exactly in every other vector. The app still cannot know the system ratio at a price that has not happened, so in Recovery Mode the simulator keeps its warning.
- Self-check: when the guardian is live, today's numbers go through the model and are compared with the contract's own `preview`; the panel says whether they agree.
- A position with no guardian (wave 1, or no policy) still shows ratio, redemption and buffer, and says nothing would act.


## Share cards

Two image routes, made with `next/og` at 1200x630: `/og/position/[wave]/[id]` and `/og/proof`. The position page `/position/[wave]/[id]` (wave 1 or 2, no wallet needed) carries the Open Graph and Twitter tags that point at them, with a share bar to copy the link.

- A position card reads the lens on the server and shows only public on-chain values: id, risk label, collateral ratio, collateral, debt, locked rate against the market rate when it is cheaper, and the shortened vault address. The holder is left out on purpose. The card model is `lib/share.ts`, and its test checks that no holder or owner field can reach the image.
- A stale node gives an "unverified" card, a failed read gives a card with no numbers, and an unknown id gives a 404 card. The id in the path must be plain digits, so a link cannot carry anything else.
- The proof card is built from `src/content/proof.json` alone (tests passing, claims verified, deployments with a matching source), with no chain read. Its footer says so.
- `ImageResponse` adds a one-year immutable `Cache-Control` and merges any header given to it, which would pin an old card in browsers. `lib/cardImage.tsx` rebuilds the response so only its own header remains: 60 seconds for a position, 15 for errors, 5 minutes for proof.
- **Site URL.** Absolute image and preview URLs come from `NEXT_PUBLIC_SITE_URL`, else `VERCEL_PROJECT_PRODUCTION_URL` (Vercel sets it, a bare host, when system environment variables are exposed). The logic is one file, `scripts/site-url.mjs`, used by both the app (`lib/share.ts`) and `next.config.mjs`. In development with neither set it is `http://localhost:3000`. In a production build it never is: a missing value, an unreadable one, or one that resolves to localhost, 127.x, 0.0.0.0, ::1 or *.localhost makes `next build` stop with a message. `siteUrl.test.ts` covers each case. Any build run with `NODE_ENV=production` needs the variable, including CI's `npm run build` and the e2e build.
- **Font.** The images use Sora from `src/assets/fonts/` (Regular and Bold TTF, with the OFL text). They are read from disk by `lib/cardFonts.ts`, and `next.config.mjs` tells the file tracer to ship them with the two image routes. Nothing is fetched at request time: a test stubs `fetch` to throw while the fonts load, another checks the image code has no font URL, and the route was run in a network-less namespace and still drew its card in Sora. A missing file falls back to the renderer's default font instead of failing. The app's own woff2 files cannot be used here because the renderer needs TTF, OTF or WOFF.

## Gas limits

`lib/gas.ts` sets the limit for every write. Nine actions that had no evidence (`repay`, `refinance`, `close`, `closeWithPermit`, `claimSurplus`, `fundReserveMusd`, `clearPolicy`, `cancelAll`, `setApprovalForAll`) are now twice a minimum measured by bisecting `eth_call` gas; the table, the method and the numbers are in `docs/INTEGRATIONS.md` and `docs/gas-measurements.json`. `gas.test.ts` ties the rules to the measurement file. The SDK's table carries the same numbers and `packages/sdk/test/webgas.test.ts` fails on drift. The app always passes hints for `repay` and `refinance`; the hintless limit (the 9.5M cap) exists for SDK callers. Mezo charges at least half the limit, so `gasUsed` in `docs/roundtrip.json` is not a measurement.

## Static pages

`/break-it` and `/proof` render `src/content/break-it.json` and `src/content/proof.json`, shipped empty. `lib/content.ts` validates them and only allows https, local http and site-relative links. Schemas are the types in that file.

## Checked in a real browser

Headless Chrome at 390 and 360 px: manage panel, all 8 tabs and an open tooltip (20 states), wave 2 fixture, buy review, and both content pages (8 states). No horizontal overflow. This found one real bug (the refinance saving sign), fixed. Scripts: `web/scripts/measure-manage.mjs`, `measure-wave2.mjs`. Fixture route: `/preview/wave2` (only with `NEXT_PUBLIC_PREVIEW=1`).

Headless Chrome (Windows) at 390 and 360 px for the app features, `web/scripts/measure-features.mjs`: `/stats`, `/proof`, the live position pages `/position/1/2` and `/position/2/1` and a missing id, the what-if simulator at rest and moved (-45% price, 120% pressure), and the price estimate, all with no horizontal overflow. A reduced-motion pass checks the stats tiles are fully visible. The what-if and price estimate were checked on the fixture route with made-up numbers, and the position pages on the live testnet. Screenshots were looked at by eye, not diffed.

## Not done or not verified

- The planner port in `lib/whatif.ts` is replayed against 503 states the contract itself answered (see What-if simulator), on the local MUSD deployment, not on a fork of testnet. The generator does not reach "price feed down" (NoPrice), and it cannot check what the app does not know: the system ratio at a hypothetical price in Recovery Mode, and the exact redemption verdict when the policy's walk is shorter than the buffer reading (the port holds). On the live testnet the check on today's numbers agreed, but that position was Healthy.
- The stats route was cross-checked against a separate log-reading script once (matched exactly) and run for real. It reads one RPC provider. Past keeper refusals cannot be counted from logs.
- Share images were fetched and looked at, but no social site or chat app was asked to unfurl one. The site URL logic is tested and the build check was run (no value and a localhost value both fail, the Vercel variable alone passes), but nothing was deployed to Vercel, so that variable's presence on a real deployment is assumed from Vercel's documentation.
- "Other addresses" counts only participants visible in the contract logs. It is a floor on who used the contracts, not a count of users.
- The price estimate's one-year horizon is an assumption, not a market fact. It was not shown inside the real sell panel with a wallet (the panel needs a connected owner); it was checked on the fixture.
- Still true from before:

- No wallet round trip was run: signing, pending and success states with a real wallet, and every transaction path, are covered by pure tests and simulation logic only. Nothing was sent.
- Component rendering is not unit tested; the plans, calls, parsers and validators are.
- The market scan has no cache across page loads; fine for testnet, see DECISIONS 27.
- Reopening a closed trove (`open` on the vault) has no screen.
