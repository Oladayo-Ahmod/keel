export interface FriendlyError {
  message: string;
  rejected: boolean;
}

interface ErrorLike {
  name?: string;
  code?: number;
  shortMessage?: string;
  message?: string;
  cause?: unknown;
  walk?: (fn?: (e: unknown) => boolean) => unknown;
}

function chain(e: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let cur = e as ErrorLike | undefined;
  for (let i = 0; cur && i < 8; i++) {
    out.push(cur);
    cur = cur.cause as ErrorLike | undefined;
  }
  return out;
}

/** Turns a wallet or viem error into one readable line, and says whether the user just said no. */
export function friendlyError(e: unknown): FriendlyError {
  const links = chain(e);
  const rejected = links.some(
    (l) => l.code === 4001 || l.name === "UserRejectedRequestError" || /user rejected|user denied/i.test(l.shortMessage ?? l.message ?? ""),
  );
  if (rejected) return { message: "You declined the request in your wallet. Nothing was sent.", rejected: true };

  const text = links.map((l) => `${l.shortMessage ?? ""} ${l.message ?? ""}`).join(" ");
  if (/insufficient funds|exceeds the balance/i.test(text)) {
    return { message: "The wallet does not hold enough BTC for this amount plus gas.", rejected: false };
  }
  // not preceded by a letter, so RefinanceFeeTooHigh is not mistaken for the borrowing fee
  if (/(^|[^A-Za-z])FeeTooHigh/.test(text)) {
    return { message: "The borrowing fee rose above your limit before the transaction ran. Try again.", rejected: false };
  }
  if (/TCR < CCR/.test(text)) {
    return {
      message: "Mezo refused it: it would push the whole system under 150% collateral. Use more collateral or borrow less.",
      rejected: false,
    };
  }
  if (/DebtCapExceeded/.test(text)) {
    return { message: "This deployment caps how much a single position can owe, and this would go over it. Borrow less.", rejected: false };
  }
  if (/NoRateImprovement/.test(text)) {
    return { message: "The market rate is no longer below this position's locked rate, so refinancing would not help.", rejected: false };
  }
  if (/RefinanceFeeTooHigh/.test(text)) {
    return { message: "The refinancing fee came out above your limit. Nothing was changed. Try again.", rejected: false };
  }
  if (/ERC721InvalidReceiver|ERC721IncorrectOwner|ERC721InsufficientApproval/.test(text)) {
    return { message: "The NFT could not be moved. The receiver may be a contract that cannot hold NFTs.", rejected: false };
  }
  const first = links.find((l) => l.shortMessage)?.shortMessage ?? links[0]?.message ?? "Unknown error";
  return { message: first.split("\n")[0].slice(0, 220), rejected: false };
}
