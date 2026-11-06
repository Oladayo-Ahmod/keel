# Known limitations

Written before the code. It will be updated as the build finds more.

- **Mezo governance risk.** All Mezo core contracts are upgradeable proxies. A hostile or accidental upgrade can break or lock Trozu positions. Trozu has no way to prevent it. See THREAT_MODEL T14.
- **Oracle risk is inherited.** The price comes from a chain precompile through `PriceFeed`. Trozu adds no oracle of its own.
- **Redemption buffer is an estimate.** It is exact only for a complete walk at one block, and it moves. Sort order uses NICR, which ignores interest and pending redistribution. A capped walk gives only a lower bound.
- **Wave 1 has no marketplace.** A wave 1 NFT sale is trust-based: the seller can change the position before the buyer's transfer lands. State-committed settlement is wave 2.
- **Wave 1 has no guardian.** Wave 1 vaults cannot be acted on by anyone but the holder. The guardian needs a vault v2 and a new factory, so wave 1 positions do not get it unless migrated.
- **A holder that cannot receive BTC cannot close or withdraw.** Payouts go to the caller. A contract holder without a payable `receive` reverts its own operations.
- **Test MUSD is scarce.** There is no MUSD faucet. Opening a trove costs at least 1800 MUSD net debt.
- **Local tests use the pinned MUSD source, not the live contracts.** The pinned commit can differ from what runs on matsnet. The final fork layer checks the live proxies, and the proxy implementations are not verified yet.
- **Not audited.** Mezo requires a third-party audit for Mezo Market featuring. This repository has not had one.
- **Recovery Mode and the last trove.** While the system is in Recovery Mode, refinance and close revert, and collateral cannot be withdrawn. The last trove in the system cannot close. These are Mezo rules, shown in the Lens as `recoveryMode` and `canClose`. See THREAT_MODEL T19.
- **`tokenURI` is empty in wave 1.**
- **Closing needs more MUSD than a position minted.** The opener receives the debt amount but owes the borrowing fee, interest and nothing for the 200 MUSD reserve. A holder must acquire a little extra MUSD to close.
