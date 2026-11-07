import { guarded, toAddress, toUint, type Context } from "./context.js";
import { TrozuNotFoundError, TrozuValidationError } from "./errors.js";
import { lensAbi } from "./generated/abis.js";
import { NO_DEBT_ICR, riskOf } from "./math.js";
import type { BufferCheck, BufferVerdict, BufferView, PositionView } from "./types.js";

/** The Lens never walks more than this many troves, and the vault refuses a policy that asks for more. */
export const MAX_WALK = 100;

const VERDICTS: BufferVerdict[] = ["unknown", "above", "below"];

export function lensReads({ client, deployment }: Context) {
  const address = deployment.trozu.lens;

  /** ICR, equity, locked against market rate and the rest of what the Lens knows about one position. */
  async function position(tokenId: bigint | number | string): Promise<PositionView> {
    const id = toUint("tokenId", tokenId);
    const i = await guarded(() => client.readContract({ address, abi: lensAbi, functionName: "positionInfo", args: [id] }));
    if (i.vault === "0x0000000000000000000000000000000000000000") throw new TrozuNotFoundError("That position does not exist.");
    return {
      tokenId: i.tokenId,
      vault: i.vault,
      holder: i.holder,
      active: i.active,
      collateral: i.coll,
      principal: i.principal,
      interest: i.interest,
      debt: i.debt,
      priceOk: i.priceOk,
      price: i.price,
      icr: i.icr,
      hasDebt: i.icr < NO_DEBT_ICR,
      equity: i.equity,
      lockedRateBps: i.lockedRateBps,
      marketRateBps: i.globalRateBps,
      spreadBps: i.spreadBps,
      annualSpreadMusd: i.annualSpreadMusd,
      claimableSurplus: i.claimableSurplus,
      refinanceFeeEstimate: i.refinanceFeeEstimate,
      redeemable: i.redeemable,
      recoveryMode: i.recoveryMode,
      canClose: i.canClose,
      risk: riskOf({ active: i.active, icr: i.icr }),
    };
  }

  /** Token ids of the positions a wallet holds. */
  async function positionsOf(holder: string): Promise<bigint[]> {
    const who = toAddress("holder", holder);
    const ids = await guarded(() => client.readContract({ address, abi: lensAbi, functionName: "positionsOf", args: [who] }));
    return [...ids];
  }

  function steps(maxSteps: number): bigint {
    if (!Number.isInteger(maxSteps) || maxSteps < 0 || maxSteps > MAX_WALK) {
      throw new TrozuValidationError([`maxSteps has to be a whole number from 0 to ${MAX_WALK}`]);
    }
    return BigInt(maxSteps);
  }

  /** How much MUSD would have to be redeemed before Mezo reaches this position, walking up to `maxSteps` troves. */
  async function redemptionBuffer(tokenId: bigint | number | string, maxSteps = MAX_WALK): Promise<BufferView> {
    const id = toUint("tokenId", tokenId);
    const b = await guarded(() => client.readContract({ address, abi: lensAbi, functionName: "redemptionBuffer", args: [id, steps(maxSteps)] }));
    return { buffer: b.buffer, eligibleAhead: b.eligibleAhead, steps: b.steps, complete: b.complete, inList: b.inList };
  }

  /**
   * The redemption buffer against a threshold, with the Lens's verdict. "above" means the walk proved
   * the buffer reaches the threshold, "below" means it walked the whole queue and it does not, and
   * "unknown" means it ran out of steps first: treat that as not proven, never as safe.
   */
  async function bufferCheck(tokenId: bigint | number | string, threshold: bigint | number | string, maxSteps = MAX_WALK): Promise<BufferCheck> {
    const id = toUint("tokenId", tokenId);
    const t = toUint("threshold", threshold);
    const [verdict, b] = await guarded(() =>
      client.readContract({ address, abi: lensAbi, functionName: "bufferAtLeast", args: [id, t, steps(maxSteps)] }),
    );
    return {
      verdict: VERDICTS[verdict] ?? "unknown",
      threshold: t,
      buffer: b.buffer,
      eligibleAhead: b.eligibleAhead,
      steps: b.steps,
      complete: b.complete,
      inList: b.inList,
    };
  }

  return { position, positionsOf, redemptionBuffer, bufferCheck };
}

export type LensReads = ReturnType<typeof lensReads>;
