/** Plain-language explanations shown behind the "?" marks. Kept here so the wording is in one place. */
export const TIPS = {
  trove:
    "A trove is a loan on Mezo. You lock BTC in it and borrow MUSD against it. Each Trozu position is one trove, kept in its own vault, and the NFT is the key to that vault.",
  icr:
    "Collateral ratio: what your BTC is worth in dollars divided by what you owe. 160% means $1.60 of BTC for every $1.00 of debt. If it falls under 110%, anyone can liquidate the trove and take part of the BTC.",
  buffer:
    "When someone redeems MUSD for BTC, Mezo takes it from the lowest-ratio troves first. The buffer is how much MUSD has to be redeemed before yours is reached. A bigger buffer means you are further back in the queue. It changes every block.",
  lockedRate:
    "The interest rate was fixed when the trove was opened or last refinanced. It stays the same even when the market rate moves, and it moves with the NFT.",
  refinance:
    "Refinancing moves the trove to today's market rate. It costs a one-off fee added to your debt. Trozu only allows it when the new rate is lower.",
  reserve:
    "The 200 MUSD liquidation reserve is added to every trove's debt. Mezo gives it back by burning it when you close, so closing costs the debt minus 200 MUSD.",
  permit:
    "A permit is a signed message that lets the vault take exactly this amount of MUSD, without a separate approval transaction. Signing costs no gas and moves nothing by itself.",
  recovery:
    "Recovery Mode switches on when the whole Mezo system falls under 150% collateral. While it lasts, Mezo blocks closing, refinancing and withdrawing collateral.",
  surplus:
    "If a redemption or liquidation takes only part of your collateral's value, the rest waits in a pool for you to claim.",
} as const;

export type TipKey = keyof typeof TIPS;
