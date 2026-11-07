// How another protocol can read a Trozu position before it lets the position count for something
// (collateral, a gated feature, a listing on its own market). Read only: nothing is signed or sent.
//
//   npx tsx examples/assess-position.ts 1
import { createTrozu, icrPercent, type PositionView } from "@trozu/sdk";

const trozu = createTrozu(); // matsnet over the public RPC

export interface Assessment {
  accept: boolean;
  reasons: string[];
  position: PositionView;
}

/**
 * The thresholds below are this example's own choices. A real integrator picks theirs.
 * `expectedHolder` is who the integrator believes owns the position: check it, because the position
 * moves with its NFT.
 */
export async function assess(tokenId: bigint, expectedHolder: string, bufferMusd: bigint): Promise<Assessment> {
  const p = await trozu.lens.position(tokenId); // throws TrozuNotFoundError for an id that was never minted
  const reasons: string[] = [];

  if (p.holder.toLowerCase() !== expectedHolder.toLowerCase()) reasons.push("the position is held by someone else");
  if (!p.active) reasons.push("the position has no open trove");
  if (!p.priceOk) reasons.push("the price feed is not answering, so the ratio cannot be trusted");
  if (p.recoveryMode) reasons.push("Mezo is in Recovery Mode");
  if (p.risk !== "safe") reasons.push(`risk is ${p.risk} (ratio ${icrPercent(p.icr)}%)`);

  // can a wave of redemptions reach it? "unknown" means the walk ran out of steps: not proven, so not accepted
  const buffer = await trozu.lens.bufferCheck(tokenId, bufferMusd, 100);
  if (buffer.verdict !== "above") reasons.push(`redemption buffer is ${buffer.verdict} for the threshold`);

  // a live guardian policy is an extra layer, not a requirement
  const g = await trozu.guardian.status(tokenId);
  if (!g.live) reasons.push("no live guardian policy (optional)");

  return { accept: reasons.filter((r) => !r.endsWith("(optional)")).length === 0, reasons, position: p };
}

if (process.argv[1]?.endsWith("assess-position.ts")) {
  const id = BigInt(process.argv[2] ?? "1");
  const holder = (await trozu.lens.position(id)).holder;
  const a = await assess(id, holder, 1_000n * 10n ** 18n);
  console.log({ accept: a.accept, reasons: a.reasons, icrPercent: icrPercent(a.position.icr), equity: a.position.equity.toString() });
}
