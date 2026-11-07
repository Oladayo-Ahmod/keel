import { formatGas, gasLimitFor } from "@/lib/gas";

/**
 * One row for a review step: the gas limit the app will send with. It is a ceiling, not a price:
 * Mezo charges at least half of the limit, and gas costs a few hundred wei, so even 6M is far under a cent.
 */
export function GasRow({ fn }: { fn: string }) {
  return (
    <div>
      <dt>Gas limit</dt>
      <dd className="mono" title="A ceiling set by the app because the node's gas estimates are unreliable. Mezo charges at least half of it; at current prices that is far under a cent.">
        {formatGas(gasLimitFor(fn))}
      </dd>
    </div>
  );
}

/** The same fact as a line, for panels that have no review list. */
export function GasNote({ fn }: { fn: string }) {
  return <p className="note">Gas limit {formatGas(gasLimitFor(fn))} (a ceiling set by the app; Mezo charges at least half of it, far under a cent).</p>;
}
