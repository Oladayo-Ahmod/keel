import { formatAmount, icrPercent, kindName, vaultAbi, LOG_WINDOW, type Trozu } from "@trozu/sdk";
import { getAbiItem, type PublicClient } from "viem";

export interface Alert {
  kind: "near-floor" | "keeper-acted";
  severity: "warning" | "critical" | "info";
  tokenId: string;
  vault: string;
  title: string;
  /** Built from numbers only. Nothing the chain wrote as text ever ends up in an alert. */
  message: string;
  /** Stable id, so a repeat can be recognised. */
  key: string;
  data: Record<string, string | number | boolean | null>;
}

export interface CheckOptions {
  trozu: Trozu;
  client: PublicClient;
  tokenIds: bigint[];
  /** Alert when the ratio is within this many percentage points of the floor, or under it. */
  marginPoints: number;
  /** First block to look for keeper actions in, inclusive. */
  fromBlock: bigint;
  toBlock: bigint;
}

const guardianAction = getAbiItem({ abi: vaultAbi, name: "GuardianAction" });
const pts = (v: bigint) => Number((v * 10_000n) / 10n ** 18n) / 100;

/**
 * Looks at each position's guardian and returns what is worth telling someone: a guarded position that is
 * within `marginPoints` of its floor (or under it), and every guardian action in the block range.
 * A position with no live policy is not guarded and never alerts: there is no floor to be near.
 */
export async function collectAlerts(o: CheckOptions): Promise<Alert[]> {
  const alerts: Alert[] = [];

  for (const id of o.tokenIds) {
    const g = await o.trozu.guardian.status(id);

    if (g.marginToFloor !== null && pts(g.marginToFloor) <= o.marginPoints) {
      const margin = pts(g.marginToFloor);
      const under = g.marginToFloor < 0n;
      const icr = icrPercent(g.plan.icr);
      const floor = icrPercent(g.policy.floorIcr);
      const canAct = g.plan.kind !== "None";
      const message =
        `Position #${id} is at ${icr}% against its ${floor}% floor` +
        (under ? `, ${Math.abs(margin)} points under it.` : `, ${margin} points of room.`) +
        (canAct
          ? ` The guardian is ready to act (${g.plan.kind}).`
          : g.plan.reason === "NoReserve"
            ? " The guardian cannot act: the reserve or this period's allowance is used up."
            : ` The guardian is not acting (${g.plan.reason}).`) +
        ` Reserve: ${formatAmount(g.reserve.btc)} BTC, ${formatAmount(g.reserve.musd, 2)} MUSD.`;
      alerts.push({
        kind: "near-floor",
        severity: under || g.plan.reason === "NoReserve" ? "critical" : "warning",
        tokenId: id.toString(),
        vault: g.vault,
        title: under ? `Position #${id} is under its guardian floor` : `Position #${id} is near its guardian floor`,
        message,
        key: `near-floor:${id}`,
        data: {
          icrPercent: icr,
          floorPercent: floor,
          marginPoints: margin,
          planKind: g.plan.kind,
          planReason: g.plan.reason,
          reserveBtc: formatAmount(g.reserve.btc, 18),
          reserveMusd: formatAmount(g.reserve.musd, 18),
        },
      });
    }

    // keeper actions, read in windows the public RPC accepts
    for (let start = o.fromBlock; start <= o.toBlock; start += LOG_WINDOW) {
      const end = start + LOG_WINDOW - 1n > o.toBlock ? o.toBlock : start + LOG_WINDOW - 1n;
      const logs = await o.client.getLogs({ address: g.vault, event: guardianAction, fromBlock: start, toBlock: end });
      for (const log of logs) {
        const a = log.args as { kind?: number; amount?: bigint; tip?: bigint; icrBefore?: bigint } | undefined;
        if (!a || a.kind === undefined || a.amount === undefined || a.tip === undefined || a.icrBefore === undefined) continue;
        const kind = kindName(a.kind);
        const unit = kind === "RepayMusd" ? "MUSD" : "BTC";
        alerts.push({
          kind: "keeper-acted",
          severity: "info",
          tokenId: id.toString(),
          vault: g.vault,
          title: `The guardian acted on position #${id}`,
          message: `Position #${id}: ${kind} of ${formatAmount(a.amount, kind === "RepayMusd" ? 2 : 5)} ${unit} from the reserve, at ${icrPercent(a.icrBefore)}% before. Keeper tip ${formatAmount(a.tip)} BTC. Block ${log.blockNumber}.`,
          key: `keeper:${log.transactionHash}:${log.logIndex}`,
          data: { kind, amount: formatAmount(a.amount, 18), tip: formatAmount(a.tip, 18), icrBeforePercent: icrPercent(a.icrBefore), block: String(log.blockNumber), tx: log.transactionHash ?? null },
        });
      }
    }
  }
  return alerts;
}
