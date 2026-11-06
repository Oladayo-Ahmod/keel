import type { ReactNode } from "react";

/** Header and footer shared by the static content pages. Plain server markup, no wallet code. */
export function ContentPage({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <main className="shell content-page">
      <header className="top">
        <div className="brand">
          <a href="/" className="link" aria-label="Back to the app">Trozu</a>
        </div>
        <nav className="subnav" aria-label="Pages">
          <a className="tab" href="/">App</a>
          <a className="tab" href="/break-it">Break it</a>
          <a className="tab" href="/proof">Proof</a>
        </nav>
      </header>
      <section className="hero">
        <h1>{title}</h1>
        <p>{lead}</p>
      </section>
      {children}
      <footer className="foot"><span>Testnet only. Not audited.</span></footer>
    </main>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="glass state" role="status">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

export function Broken({ file, errors }: { file: string; errors: string[] }) {
  return (
    <div className="glass state state-error" role="alert">
      <h3>This page&apos;s data file is malformed</h3>
      <p>{file} did not pass its checks, so nothing from it is shown.</p>
      <code className="err-detail">{errors.slice(0, 5).join("; ")}</code>
    </div>
  );
}
