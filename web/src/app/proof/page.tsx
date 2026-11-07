import { Broken, ContentPage, Empty } from "@/components/ContentChrome";
import { parseProof } from "@/lib/content";
import raw from "@/content/proof.json";

export const metadata = { title: "Proof · Trozu" };

const num = (n: number | null) => (n === null ? "not recorded" : n.toLocaleString("en-US"));

export default function Page() {
  const r = parseProof(raw);
  return (
    <ContentPage
      title="Proof"
      lead="Each claim about Trozu, how it was checked, and a link to the evidence. A claim with no evidence is marked open."
    >
      {!r.ok && <Broken file="src/content/proof.json" errors={r.errors} />}
      {r.ok && (
        <>
          <section className="glass panel" aria-label="Test summary">
            <header className="panel-head"><h2>Tests</h2></header>
            <dl className="preview">
              <div><dt>Tests</dt><dd className="mono">{num(r.data.summary.tests)}</dd></div>
              <div><dt>Passing</dt><dd className="mono">{num(r.data.summary.passing)}</dd></div>
              <div><dt>Invariants</dt><dd className="mono">{num(r.data.summary.invariants)}</dd></div>
            </dl>
            {r.data.summary.note && <p className="note">{r.data.summary.note}</p>}
          </section>

          <p className="note">
            Numbers that change, such as positions created, sales and keeper actions, are on the{" "}
            <a className="link" href="/stats">live stats page</a>, read from the contract logs on each load.
          </p>

          <section className="grid-stack" aria-label="Claims">
            <h2>Claims</h2>
            {r.data.claims.length === 0 && <Empty title="No claims recorded yet" body="This fills in from src/content/proof.json." />}
            {r.data.claims.map((c) => (
              <article key={c.id} className="glass card">
                <header className="card-head">
                  <div><h3>{c.claim}</h3><span className="addr">{c.id}</span></div>
                  <span className={`chip ${c.status === "verified" ? "chip-safe" : "chip-caution"}`}>{c.status === "verified" ? "Verified" : "Open"}</span>
                </header>
                <p className="note">{c.how}</p>
                {c.evidence.length > 0 && (
                  <ul className="evidence">
                    {c.evidence.map((e) => <li key={e.href}><a className="link" href={e.href} target="_blank" rel="noreferrer">{e.label}</a></li>)}
                  </ul>
                )}
              </article>
            ))}
          </section>

          <section className="grid-stack" aria-label="Deployments">
            <h2>Deployments</h2>
            {r.data.deployments.length === 0 && <Empty title="No deployments listed yet" body="This fills in from src/content/proof.json." />}
            {r.data.deployments.map((d) => (
              <article key={d.address} className="glass card">
                <header className="card-head">
                  <div><h3>{d.name}</h3><a className="addr mono" href={d.explorer} target="_blank" rel="noreferrer">{d.address}</a></div>
                  <span className={`chip ${d.verification === "exact" ? "chip-safe" : d.verification === "partial" ? "chip-caution" : "chip-none"}`}>
                    {d.verification === "exact" ? "Source matches" : d.verification === "partial" ? "Partial match" : "Not verified"}
                  </span>
                </header>
                {d.note && <p className="note">{d.note}</p>}
              </article>
            ))}
          </section>
          {r.data.updated && <p className="note">Last updated {r.data.updated}.</p>}
        </>
      )}
    </ContentPage>
  );
}
