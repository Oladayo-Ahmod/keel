# Web threats

Scope: the app in `web/`. It holds no keys and sends nothing on its own. The contract threats are in `docs/THREAT_MODEL.md`.

| ID | Threat | What the app does | Residual |
|---|---|---|---|
| W1 | A lagging RPC node shows old balances or ratio | Every read that feeds a decision is paired with a head block and judged. Plans are not produced from stale data. `assertFresh()` runs again before any simulation or signature. | A node that is current but wrong is not detected. |
| W2 | A bad hint or amount wastes gas or reverts | Hints are looked up at the confirm step. Every call is simulated first, and reverts show as sentences. | Hints are approximate after a repay or borrow; a poor hint costs gas, never funds. |
| W3 | A permit signature is reused or stolen | Domain is checked against the token's `DOMAIN_SEPARATOR` before signing. Value is exact (repay, reserve, buy at `maxPrice`) and the window is ten minutes. | A signature is valid until used or expired. |
| W4 | Close permit voided by interest | Close never uses a permit; it approves 0.1% above the cost. | The vault's `closeWithPermit` stays in the ABI and is unusable with a signed exact amount. |
| W5 | Buyer pays for a position that changed | Bounds pin collateral, debt, rate and reserve, with headroom only for interest. The sale is simulated before the wallet opens. | Debt headroom of 0.5% is real money on a large position. |
| W6 | Dutch price drifts against the buyer | The cap is the price one minute ago, so clock skew cannot revert a fair buy. | The buyer can pay up to one minute's worth of price drift above the live price. |
| W7 | Malformed content file renders unsafe links | `lib/content.ts` allows https, local http and site paths only and shows a notice for a bad file. | None known. |
| W8 | A listing is signed against a browser clock that runs ahead | The listing uses the latest block timestamp. | None known. |
| W9 | Log scanning misses listings | The page says which block range it read. Every shown row is re-checked on chain, and `buy` re-checks again. | A missed listing is invisible, never mispriced. |
| W10 | The price estimate is read as a valuation, or built from stale or missing data | It is labelled an estimate, lists every input, and says nobody has to pay it. It is hidden when the node is stale, the price feed is down or the trove is closed, and it only copies a number into the field. | The one-year horizon is an assumption. A seller can still list far from the estimate, and the estimate cannot know what a buyer wants. |
| W11 | The stats page shows wrong or old counts as if they were exact | Each count says what it is built from. A stale head, an incomplete range, a dropped start block, a failed read and a listing count that is not exact are each written on the page. Vault events count only from factory vaults. | Counts come from one RPC provider. A node that is current but wrong is not detected. Refusals in the past are not observable. |
| W12 | Anyone can load the stats route to drain the RPC | The result is shared for about a minute and one read runs at a time per server. Reads are capped in range, time and calls. | Many server instances each read once a minute. |
| W13 | The simulator is taken as a forecast, or its planner port drifts from the contract | Marked a model next to the sliders, with the left-out effects listed. The port has one test per branch of `_plan`. With a live policy, today's numbers are compared with the contract's `preview` and a disagreement is shown. | The port was checked against the contract's logic by reading it and by tests, not by running both on the same fork state. The walk-step rule is approximated. |

Tests: `fairprice.test.ts`, `stats.test.ts`, `statsSnapshot.test.ts`, `whatif.test.ts`, `manage.test.ts`, `permit.test.ts`, `vaultCall.test.ts`, `market.test.ts`, `guardian.test.ts`, `content.test.ts`, `errors.test.ts`, `freshness.test.ts`.
