# Manual test checklist

The wallet round trip (the prompt, the pending state, the success animation) has not been seen end to end by anyone yet. This is the list to follow. Tick each line, and note what you saw if it differs.

## Before you start

- Wallet: a browser wallet (MetaMask or similar) on Mezo Testnet, chain id 31611, RPC `https://rpc.test.mezo.org`, symbol BTC. Testnet BTC from https://faucet.test.mezo.org/.
- App: `cd web && npm install --legacy-peer-deps && cp .env.example .env.local`, put your WalletConnect project id in it, `npm run dev`, open http://localhost:3000.
- Have a second address ready that you control, for the transfer. A second wallet account is enough.
- Open the browser console. Anything red there is worth reporting.
- Useful ids: positions 1 and 2 are held by the deployer wallet (`0x5104…8F98`) and can be looked up without a wallet at `/?id=1` and `/?id=2`.

## 1. Connect

- [ ] The page loads with the empty state "Connect a wallet to see your positions" and a block number pill in the header (for example "Block 16,299,103").
- [ ] **Connect Wallet** lists your browser wallet. Connecting shows your address in the header.
- [ ] A wallet with no positions shows "No positions in this wallet yet" and the Open form below it.
- [ ] A wallet with positions shows the totals strip and one card per position, sliding in one after another.
- [ ] Reload the page while connected: the same cards come back, with no flash of a "healthy" ratio before the numbers load.
- [ ] Disconnect: the empty state returns.
- [ ] Bitcoin wallets (Unisat, OKX, Xverse) are offered by Mezo Passport. They are not tested at all. If you have one, try it and report.

## 2. Open a position

Use small numbers. The minimum is 1,800 MUSD including the 0.1% fee, so roughly 0.037 BTC at 150% (price about 82,000 USD).

- [ ] Enter 1800 as the amount to borrow. Press the **160% ratio** button: the collateral box fills in.
- [ ] The preview shows ratio, borrowing fee (about 1.80 MUSD), total debt (about 2,001.80, which includes Mezo's 200 MUSD reserve) and equity. No "healthy" wording appears anywhere on this form.
- [ ] Type a collateral amount that gives about 130%: a yellow warning about 150%. Type one under 120%: a red error and **Review** is disabled.
- [ ] Type a borrow amount under 1,800: an error naming the minimum. Type letters: the field turns red.
- [ ] Ask for more collateral than the wallet holds: "Not enough BTC".
- [ ] **Review** shows the summary and says hints are looked up when you press the button.
- [ ] Press **Open position**. Expected order: "Checking…", then the wallet prompt, then "Waiting for the network" with a hash link, then a green "Done" with "Position #N is yours".
- [ ] The hash link opens the transaction on explorer.test.mezo.org. The transaction should have used roughly 0.9M gas.
- [ ] The new card appears in the list with a ratio close to what you chose.
- [ ] **Open another** resets the form.

## 3. Transfer

Do this on a position you can afford to lose control of for a minute, to your own second address.

- [ ] A card you hold shows **Transfer** in its footer. A card you do not hold (look one up with `/?id=1` from a different wallet) does not.
- [ ] **Transfer** opens a panel with ratio, equity, collateral, debt and locked rate, and the sentence saying the new holder gets everything.
- [ ] A healthy position: **Continue** is enabled at once.
- [ ] Next step: paste your second address.
  - [ ] Empty, "0x123", the zero address, your own address, and the vault or NFT contract address each give a clear message and block **Continue**.
  - [ ] A good address continues. Mixed-case and lower-case both work.
- [ ] Confirm step shows the full address and asks for its last 4 characters. **Transfer position** stays disabled until you type them correctly.
- [ ] Press it. Expected: wallet prompt, "Waiting for the network", then "The position now belongs to the receiver", and the card slides away. A hash link opens the transaction.
- [ ] Switch the wallet to the second address. The position is in its list, with the same collateral, debt and ratio.
- [ ] Look up the same id from the first address: it shows "Held by 0x…", with no Transfer button.
- [ ] From the explorer, the NFT contract `0xEF89…948C` shows a Transfer event to the second address.
- [ ] Transfer it back from the second address, so nothing stays stranded.
- [ ] An underwater or low-ratio position (under 125%) asks you to type TRANSFER before it lets you continue. You will need to wait for the oracle to move or open a deliberately thin position on testnet to see this. It is covered by unit tests and a fixture page.
- [ ] A contract as receiver: a plain contract that does not accept NFTs should be flagged as a contract, and the simulation should refuse it before the wallet prompt.

## 4. Wrong network

- [ ] With the wallet on another network (for example Ethereum), the page shows the amber "Your wallet is on another network" banner with a **Switch** button. It should switch the wallet to Mezo Testnet.
- [ ] While on the wrong network the Open form says to switch first and **Review** stays disabled.
- [ ] After switching, everything works without a reload.

## 5. Rejected signature

- [ ] Start an open, and press **Reject** in the wallet. Expected: "You declined the request in your wallet. Nothing was sent.", not a scary error, and the button changes to **Try again**.
- [ ] Do the same with a transfer. The card must stay, and the panel must stay on the confirm step.
- [ ] After a rejection, press **Try again** and approve: it should go through.
- [ ] Confirm on the explorer that the rejected attempt left no transaction.

## 6. Stale or failing RPC

The public RPC is load balanced across nodes that can be far apart, and about one request in twenty fails with a TLS error. The app asks for the head block together with each read and retries if the node that answered is behind.

- [ ] Normally the header shows a block number and no warning. Leave the tab open a few minutes: it keeps updating.
- [ ] Automated check, no wallet needed: build and serve the app, then run `node web/scripts/stale-check.mjs http://localhost:3000` with `CHROME` pointing at a Chrome binary. It fakes an old head and expects the stale warning, a "Stale data" chip and no "Healthy", then fakes three stale answers and expects the app to recover on its own.
- [ ] Manual: in browser devtools, Network tab, block requests to `rpc.test.mezo.org`, then reload. Expected: the header says "RPC unreachable" or "Node behind", cards show an error with **Try again**, and the Open form cannot be submitted.
- [ ] Unblock and press **Try again**: the data returns.
- [ ] If a card ever shows "Stale data", check that **Transfer** is disabled and that no ratio is shown as healthy or at risk. Detection can take up to about 25 seconds while the app retries, and the page shows its loading state, not old numbers, during that time.
- [ ] Right after a transaction, the list may lag for a moment on a slow node. The app refreshes on its own. If the card stays unchanged for over a minute, check the explorer and report it.

## What to report

For anything that fails: the step number, what you expected, what you saw, a screenshot, the transaction hash if there is one, and the console output. A tx hash that is stuck on "Waiting for the network" for more than two minutes is worth reporting even if it later succeeds.
