import { Broken, ContentPage, Empty } from "@/components/ContentChrome";
import { parseBreakIt, type Result } from "@/lib/content";
import raw from "@/content/break-it.json";

export const metadata = { title: "Break it · Trozu" };

const LABEL: Record<Result, string> = { blocked: "Blocked", succeeded: "Got through", partial: "Partly worked" };
const CHIP: Record<Result, string> = { blocked: "chip-safe", succeeded: "chip-danger", partial: "chip-caution" };

export default function Page() {
  const r = parseBreakIt(raw);
  return (
    <ContentPage
      title="Break it"
      lead="What we tried against Trozu, what happened, and where to check it yourself. Attempts that got through are listed the same way as the ones that did not."
    >
      {!r.ok && <Broken file="src/content/break-it.json" errors={r.errors} />}
      {r.ok && r.data.intro && <p className="note">{r.data.intro}</p>}
      {r.ok && r.data.attempts.length === 0 && (
        <Empty title="No attempts written up yet" body="This page fills in from src/content/break-it.json. Nothing is shown until the attempts have been run and recorded." />
      )}
      {r.ok && (
        <div className="grid-stack">
          {r.data.attempts.map((a) => (
            <article key={a.id} className="glass card">
              <header className="card-head">
                <div>
                  <h3>{a.title}</h3>
                  <span className="addr">{a.id}{a.threat ? ` · threat ${a.threat}` : ""}</span>
                </div>
                <span className={`chip ${CHIP[a.result]}`}>{LABEL[a.result]}</span>
              </header>
              <div className="block"><h4>The attack</h4><p className="note">{a.attack}</p></div>
              <div className="block"><h4>What happened</h4><p className="note">{a.why}</p></div>
              {a.evidence.length > 0 && (
                <ul className="evidence">
                  {a.evidence.map((e) => (
                    <li key={e.href}><a className="link" href={e.href} target="_blank" rel="noreferrer">{e.label}</a></li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
      {r.ok && r.data.updated && <p className="note">Last updated {r.data.updated}.</p>}
    </ContentPage>
  );
}
