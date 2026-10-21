import { getAddress, isAddress } from "viem";
import { config } from "@/config";
import { CAUTION } from "./risk";

const NO_DEBT = 2n ** 200n;

interface TransferSubject {
  vault: string;
  active: boolean;
  priceOk: boolean;
  equity: bigint;
  icr: bigint;
}

/** Why a receiver address cannot be used, if it cannot. */
export function receiverProblem(raw: string, self: string | undefined, p: Pick<TransferSubject, "vault">): string | undefined {
  const t = raw.trim();
  if (!t) return "Enter the address that should receive the position.";
  if (!isAddress(t, { strict: false })) return "That is not a valid address.";
  const a = getAddress(t.toLowerCase());
  if (/^0x0{40}$/.test(a.toLowerCase())) return "The zero address would burn the position.";
  if (self && a.toLowerCase() === self.toLowerCase()) return "That is your own address.";
  const own = [p.vault, config.keel.nft, config.keel.factory, config.keel.lens, config.mezo.musd].map((x) => x.toLowerCase());
  if (own.includes(a.toLowerCase())) return "That is a protocol contract, not a person.";
  return undefined;
}

/** Whether a position needs the typed-word confirmation before it can be handed over. */
export function isRisky(p: TransferSubject): boolean {
  if (!p.active) return false;
  if (!p.priceOk) return true;
  return p.equity <= 0n || (p.icr < NO_DEBT && p.icr < CAUTION);
}
