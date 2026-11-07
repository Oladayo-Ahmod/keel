# Wallet round trip through the real UI

Run on 2026-11-07 against Mezo testnet (chain 31611) and the Wave 2 contracts, with a test-only wagmi connector (`web/src/e2e/config.ts`) whose wallet is a burner key held by the test runner (`web/e2e/roundtrip.ts`). The key comes from `.env` and is never printed or shipped; `npm run check:no-e2e` fails if the connector reaches a production build. Every action below went through the app's own components and `useTx`, at a 390 px viewport. Raw data: [roundtrip.json](roundtrip.json); screenshots of the signing, pending, success and error states: [roundtrip/](roundtrip/).

**Reading the gas columns.** The limit is what the app asked for. Mezo charges at least half of the limit, so a receipt never shows less than half of it: a `used` value of exactly half the limit means the real use was at or below that. Only the upper bound is known for those; it is not a measurement of the call.

| Action | Result | Transaction | Gas limit | Gas used |
|---|---|---|---|---|
| Add collateral 0.0005 BTC (`addCollateral`) | ran | [`0x8d2c60c2...5d13`](https://explorer.test.mezo.org/tx/0x8d2c60c259f51d027864ec6c9dac811c8c44dd99bf91cfd22f0d9560f58f5d13) | 6,000,000 | 3,000,000 |
| Wallet rejects an add (error state) (`addCollateral`) | ran | no hash (rejected in the wallet) | 6,000,000 |  |
| Withdraw 0.0002 BTC (stays far above 150%) (`withdrawCollateral`) | ran | [`0x9d5f7c86...fab6`](https://explorer.test.mezo.org/tx/0x9d5f7c8641bccda3146fc4ea38316a9af1dfd1d008c36271490b211a58ccfab6) | 6,000,000 | 3,000,000 |
| Borrow 10 MUSD (`borrow`) | ran | [`0x6f90cd1b...fe3b`](https://explorer.test.mezo.org/tx/0x6f90cd1bd8f19aff4728656f1bf8e3b77faf15d11b3a3b52243766358aa2fe3b) | 6,000,000 | 3,000,000 |
| Repay 1 MUSD with a signed permit (Mezo allows at most 1.83: the 2,000 MUSD minimum debt) (`repayWithPermit`) | ran | [`0x2616fd31...4573`](https://explorer.test.mezo.org/tx/0x2616fd3181916b4b5156ccb83084f297cc2291f87dd13379c344b3f618504573) | 6,000,000 | 3,000,000 |
| Sweep stray BTC | not run | none | | |
| Sweep stray MUSD out of the vault (`sweep`) | ran | [`0x5e9e6632...575e`](https://explorer.test.mezo.org/tx/0x5e9e66324d51952529e61d87591acfaabad8cac526530228986f33e62205575e) | 1,000,000 | 500,000 |
| Claim surplus | not run | none | | |
| Refinance | not run | none | | |
| Guardian: save a policy (`setPolicy`) | ran | [`0x661abb34...13c3`](https://explorer.test.mezo.org/tx/0x661abb34c7be0163471cfceaa767044590958c19bbf4461aea07ee88b1af13c3) | 3,900,000 | 1,950,000 |
| Guardian reserve: add 0.0001 BTC (`fundReserveBtc`) | ran | [`0x8fbd9803...f0b8`](https://explorer.test.mezo.org/tx/0x8fbd9803f60831e968a14acd887635733e368d6a7f8f1c660ac609a55d4ff0b8) | 1,000,000 | 500,000 |
| Guardian reserve: take out 0.0001 BTC (`withdrawReserveBtc`) | ran | [`0x229461c1...6965`](https://explorer.test.mezo.org/tx/0x229461c146076e4fcbc296e6fdd3b601bff57f10f7160f9e92aaada6ce4a6965) | 1,000,000 | 500,000 |
| Guardian reserve: add 5 MUSD (permit) (`fundReserveMusdWithPermit`) | ran | [`0x946c494d...c5ad`](https://explorer.test.mezo.org/tx/0x946c494d73a055167f5f2a264d39377127ba5839b654d3b2f3728dba4d2fc5ad) | 1,000,000 | 500,000 |
| Guardian reserve: take out 5 MUSD (`withdrawReserveMusd`) | ran | [`0x1f9b9354...9c70`](https://explorer.test.mezo.org/tx/0x1f9b9354c17c1d8c472f66b1c70a9a48df6973dc799cacd6b19ea3e5cfa69c70) | 1,000,000 | 500,000 |
| List fixed price 100 MUSD (the one the second wallet buys) (`announce`) | ran | [`0x84a7743f...6f7c`](https://explorer.test.mezo.org/tx/0x84a7743f4d179a36c24fecad6e293169908582565ec349ab308f051a16e36f7c) | 1,000,000 | 500,000 |
| List fixed price 7,000 MUSD (to cancel) (`announce`) | ran | [`0xbf412d79...f222`](https://explorer.test.mezo.org/tx/0xbf412d7981287308ccb2d9f6685d31b221132742ba8ba8cb5fd6a1bb15f1f222) | 1,000,000 | 500,000 |
| Second wallet buys the 100 MUSD listing (permit) (`buy`) | ran | [`0xf32de59b...5855`](https://explorer.test.mezo.org/tx/0xf32de59bc28e9382785130b209770dc65f2a5f2d8883b36fc5285cad70535855) | 1,500,000 | 750,000 |
| Second wallet transfers the position back (`safeTransferFrom`) | ran | [`0x7d311c24...576f`](https://explorer.test.mezo.org/tx/0x7d311c242eaebaeea821833edb8189cd4b0648f1f01a44b972ca5fd13daa576f) | 1,000,000 | 500,000 |
| List fixed price 7,000 MUSD again (the first died with the transfer) (`announce`) | ran | [`0xafdae36d...bf6c`](https://explorer.test.mezo.org/tx/0xafdae36d8709fd17ac27418f97b6ff69d266557f22e5647769d5b82c5b66bf6c) | 1,000,000 | 500,000 |
| Cancel the 7,000 MUSD listing (`cancel`) | ran | [`0x69a7d4e1...42a4`](https://explorer.test.mezo.org/tx/0x69a7d4e15a42ac8a4796c88449c29ce7f43d875dcadf0d348d3075f717b642a4) | 1,000,000 | 500,000 |
| List a Dutch auction 9,000 to 5,000 MUSD over 30 days, open 30 days (staged for the browse view) (`announce`) | ran | [`0x2f2f9a05...5d96`](https://explorer.test.mezo.org/tx/0x2f2f9a051ba91103fd87fb94909e214582e27a9416f6b6317d4bbe3e0a0b5d96) | 1,000,000 | 500,000 |
| List fixed price 6,000 MUSD (staged for the browse view) (`announce`) | ran | [`0x0bef825f...cbf9`](https://explorer.test.mezo.org/tx/0x0bef825f83e2de7418f95be1a375db821925a8ab07084a144d467ddb664ecbf9) | 1,000,000 | 500,000 |
| Open a position | not run | none | | |
| Close a position | not run | none | | |

## Not run, and why

- **Sweep stray BTC.** Not run: the vault has no plain BTC receive, so a normal send reverts and only a forced send (selfdestruct) could leave BTC in it. The sweep button stays disabled with nothing to sweep, which is the verified behaviour; the BTC sweep path is covered by Foundry tests.
- **Claim surplus.** Not run: nothing to claim (no redemption or liquidation has left surplus), so the app keeps the button disabled. The disabled state is the verified behaviour.
- **Refinance.** Not run: no lower global rate exists. Panel text: 
- **Open a position.** Not run: needs about 0.029 BTC of collateral (1,800 MUSD minimum at the 110% floor) and the deployer holds less. Unverified through the UI on this build.
- **Close a position.** Not run on the proof position (it would need roughly the full debt in MUSD and ends the demo), and a second position costs about 0.029 BTC. Unverified through the UI on this build.

## What the run found

- **Gas is charged at no less than half the limit.** A plain self-send checked on 2026-11-07: limit 21,000 charged 21,000; 100,000 charged 50,000; 1,000,000 charged 500,000; 6,000,000 charged 3,000,000 (effective price 292 wei). Even 6M costs under 0.000000001 BTC, but earlier notes that said the unused part of a limit is free were wrong and are corrected.
- **Repay is limited by the minimum debt.** The first repay attempt (50 MUSD) was refused by the app before the wallet opened, with Mezo's real rule: composite debt must stay at or above 2,000 MUSD, so at most 1.83 MUSD could be repaid. The run repaid 1 MUSD with a permit.
- **A listing can stay open at most 30 days.** A 31-day Dutch listing was refused by the form; the staged one uses 30.
- **A dropped node request showed as An unknown RPC error occurred.** It happened on a borrow, a buy and a policy save while the public node dropped connections. Nothing had been sent in any of them. The app now says the node did not answer and to check the explorer before retrying (`web/src/lib/errors.test.ts`). The test runner also retries a send only while the account nonce has not moved.
- **Driver bugs, not app bugs:** the stray-MUSD helper used an ABI without 	ransfer, and the transfer step typed the confirmation tail into the receiver field because it did not wait for the confirm step. Both fixed in the runner.

