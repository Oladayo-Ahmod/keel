# Web app: wave 2 work

Area: `web/` only. Test count at this commit: 141 passing in 11 files (`npm test`), 42 of them from wave 1. Typecheck clean, production build clean.

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
- The page prints when it was updated, the block range and the age of the newest block. The proof page links to it.
- Cross-check: on 2026-11-07 the route's counts (1 position, 10 announced, 2 cancelled, 3 sold, same volume and fee) matched a separate script reading the same logs.

## Static pages

`/break-it` and `/proof` render `src/content/break-it.json` and `src/content/proof.json`, shipped empty. `lib/content.ts` validates them and only allows https, local http and site-relative links. Schemas are the types in that file.

## Checked in a real browser

Headless Chrome at 390 and 360 px: manage panel, all 8 tabs and an open tooltip (20 states), wave 2 fixture, buy review, and both content pages (8 states). No horizontal overflow. This found one real bug (the refinance saving sign), fixed. Scripts: `web/scripts/measure-manage.mjs`, `measure-wave2.mjs`. Fixture route: `/preview/wave2` (only with `NEXT_PUBLIC_PREVIEW=1`).

## Not done or not verified

- No wallet round trip was run: signing, pending and success states with a real wallet, and every transaction path, are covered by pure tests and simulation logic only. Nothing was sent.
- Component rendering is not unit tested; the plans, calls, parsers and validators are.
- The market scan has no cache across page loads; fine for testnet, see DECISIONS 27.
- Reopening a closed trove (`open` on the vault) has no screen.
