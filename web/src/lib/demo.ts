/** A listing is a demo listing when the team's own wallet announced it. */
export const isDemoSeller = (seller: string, team: Set<string>) => team.has(seller.toLowerCase());

/** What the market list says about the listings on screen, from who sold them. */
export function marketNotice(sellers: string[], team: Set<string>): { demo: number; total: number; text: string } {
  const total = sellers.length;
  const demo = sellers.filter((s) => isDemoSeller(s, team)).length;
  const base = "Testnet only. Listings from the team's own wallets are marked Demo listing: they are there to show the market working, and they are not user adoption.";
  if (total === 0) return { demo, total, text: base };
  if (demo === total) return { demo, total, text: `${base} Every listing shown is a demo listing, so all activity here so far was run by the team.` };
  return { demo, total, text: `${base} ${demo} of the ${total} listings shown ${demo === 1 ? "is a demo listing" : "are demo listings"}.` };
}
