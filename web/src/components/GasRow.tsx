import { formatGas, gasLimitFor } from "@/lib/gas";

/**
 * One row for a review step: the gas limit the app will send with. It is a ceiling, not a price:
 * the unused part is not charged, and gas on Mezo costs a few hundred wei.
 */
export function GasRow({ fn }: { fn: string }) {
  return (
    <div>
      <dt>Gas limit</dt>
      <dd className="mono" title="A ceiling set by the app because the node's gas estimates are unreliable. You pay only the gas used.">
        {formatGas(gasLimitFor(fn))}
      </dd>
    </div>
  );
}

/** The same fact as a line, for panels that have no review list. */
export function GasNote({ fn }: { fn: string }) {
  return <p className="note">Gas limit {formatGas(gasLimitFor(fn))} (a ceiling; you pay only what is used).</p>;
}
