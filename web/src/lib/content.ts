/**
 * Shapes of the two content files the integrator fills in: src/content/break-it.json and
 * src/content/proof.json. The pages render only what is in them and never fill a gap with a number,
 * so an empty file shows an honest "nothing here yet" page. The checks below keep a malformed file
 * from rendering as a broken page or an unsafe link.
 */

export interface Evidence {
  label: string;
  href: string;
}

export type Result = "blocked" | "succeeded" | "partial";

export interface Attempt {
  id: string;
  title: string;
  threat?: string;
  attack: string;
  result: Result;
  why: string;
  evidence: Evidence[];
}

export interface BreakIt {
  updated: string | null;
  intro: string | null;
  attempts: Attempt[];
}

export type ClaimStatus = "verified" | "open";

export interface Claim {
  id: string;
  claim: string;
  status: ClaimStatus;
  how: string;
  evidence: Evidence[];
}

export interface Deployment {
  name: string;
  address: string;
  explorer: string;
  verification: "exact" | "partial" | "none";
  note?: string;
}

export interface Proof {
  updated: string | null;
  summary: { tests: number | null; passing: number | null; invariants: number | null; note: string | null };
  claims: Claim[];
  deployments: Deployment[];
}

export type Parsed<T> = { ok: true; data: T } | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const numOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** Only http(s) links and site-relative paths, so a content file cannot smuggle in a script URL. */
export function safeHref(h: unknown): h is string {
  return typeof h === "string" && (/^https:\/\/[^\s]+$/.test(h) || /^http:\/\/(localhost|127\.0\.0\.1)[:/][^\s]*$/.test(h) || /^\/[^\s/][^\s]*$/.test(h));
}

function evidence(v: unknown, where: string, errors: string[]): Evidence[] {
  if (!Array.isArray(v)) {
    errors.push(`${where}: evidence must be a list`);
    return [];
  }
  const out: Evidence[] = [];
  v.forEach((e, i) => {
    if (isObj(e) && str(e.label) && safeHref(e.href)) out.push({ label: e.label, href: e.href });
    else errors.push(`${where}: evidence ${i + 1} needs a label and an https link or a site path`);
  });
  return out;
}

export function parseBreakIt(raw: unknown): Parsed<BreakIt> {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["the file is not a JSON object"] };
  if (!strOrNull(raw.updated)) errors.push("updated must be a string or null");
  if (!strOrNull(raw.intro)) errors.push("intro must be a string or null");
  if (!Array.isArray(raw.attempts)) errors.push("attempts must be a list");
  const attempts: Attempt[] = [];
  (Array.isArray(raw.attempts) ? raw.attempts : []).forEach((a, i) => {
    const w = `attempt ${i + 1}`;
    if (!isObj(a)) return errors.push(`${w} is not an object`);
    const ok = str(a.id) && str(a.title) && str(a.attack) && str(a.why) && (a.result === "blocked" || a.result === "succeeded" || a.result === "partial");
    if (!ok) return errors.push(`${w} needs id, title, attack, why and a result of blocked, succeeded or partial`);
    if (a.threat !== undefined && !str(a.threat)) errors.push(`${w}: threat must be text such as "T3"`);
    attempts.push({
      id: a.id as string,
      title: a.title as string,
      threat: typeof a.threat === "string" ? a.threat : undefined,
      attack: a.attack as string,
      result: a.result as Result,
      why: a.why as string,
      evidence: evidence(a.evidence ?? [], w, errors),
    });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { updated: raw.updated as string | null, intro: raw.intro as string | null, attempts } };
}

export function parseProof(raw: unknown): Parsed<Proof> {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["the file is not a JSON object"] };
  if (!strOrNull(raw.updated)) errors.push("updated must be a string or null");
  const s = raw.summary;
  if (!isObj(s) || !numOrNull(s.tests) || !numOrNull(s.passing) || !numOrNull(s.invariants) || !strOrNull(s.note)) {
    errors.push("summary needs tests, passing, invariants (numbers or null) and note (string or null)");
  }
  if (!Array.isArray(raw.claims)) errors.push("claims must be a list");
  if (!Array.isArray(raw.deployments)) errors.push("deployments must be a list");
  const claims: Claim[] = [];
  (Array.isArray(raw.claims) ? raw.claims : []).forEach((c, i) => {
    const w = `claim ${i + 1}`;
    if (!isObj(c) || !str(c.id) || !str(c.claim) || !str(c.how) || (c.status !== "verified" && c.status !== "open")) {
      return errors.push(`${w} needs id, claim, how and a status of verified or open`);
    }
    claims.push({ id: c.id, claim: c.claim, how: c.how, status: c.status, evidence: evidence(c.evidence ?? [], w, errors) });
  });
  const deployments: Deployment[] = [];
  (Array.isArray(raw.deployments) ? raw.deployments : []).forEach((d, i) => {
    const w = `deployment ${i + 1}`;
    if (!isObj(d) || !str(d.name) || typeof d.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(d.address) || !safeHref(d.explorer) || !["exact", "partial", "none"].includes(d.verification as string)) {
      return errors.push(`${w} needs a name, a 0x address, an explorer link and verification of exact, partial or none`);
    }
    deployments.push({ name: d.name, address: d.address, explorer: d.explorer, verification: d.verification as Deployment["verification"], note: typeof d.note === "string" ? d.note : undefined });
  });
  if (errors.length) return { ok: false, errors };
  const sm = s as Obj;
  return {
    ok: true,
    data: {
      updated: raw.updated as string | null,
      summary: { tests: sm.tests as number | null, passing: sm.passing as number | null, invariants: sm.invariants as number | null, note: sm.note as string | null },
      claims,
      deployments,
    },
  };
}
