import type { Alert } from "./check.js";

export type WebhookFormat = "slack" | "discord" | "json" | "auto";

/** Where a webhook points, for logs. The path is the secret, so only the host is ever printed. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

/** The webhook must be https, except for a local test server. Returns the reason it is refused, if it is. */
export function urlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "WEBHOOK_URL is not a valid URL";
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return "WEBHOOK_URL must be https";
  return null;
}

export function detectFormat(url: string): Exclude<WebhookFormat, "auto"> {
  const host = hostOf(url);
  if (host === "hooks.slack.com") return "slack";
  if (/(^|\.)discord(app)?\.com$/.test(host)) return "discord";
  return "json";
}

const ICON = { critical: "🔴", warning: "🟠", info: "🔵" } as const;

/** One line per alert, then the details. Plain text, so it reads the same in Slack, Discord and a log. */
export function renderText(alerts: Alert[]): string {
  return alerts.map((a) => `${ICON[a.severity]} ${a.title}\n${a.message}`).join("\n\n");
}

/** The body to POST. `json` carries the structured alerts too, for anything that wants to route on them. */
export function buildPayload(alerts: Alert[], format: WebhookFormat, url = ""): unknown {
  const f = format === "auto" ? detectFormat(url) : format;
  const text = renderText(alerts);
  // Discord truncates at 2000 characters and rejects more
  if (f === "discord") return { content: text.length > 1900 ? `${text.slice(0, 1899)}…` : text };
  if (f === "slack") return { text };
  return { text, alerts };
}

export interface PostOptions {
  fetchImpl?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  /** Wait between attempts. Tests set this to 0. */
  backoffMs?: number;
}

export class WebhookError extends Error {}

/**
 * POSTs the payload. One retry on a network error, a 429 or a 5xx. Errors never contain the URL, because
 * it carries the secret.
 */
export async function post(url: string, payload: unknown, o: PostOptions = {}): Promise<void> {
  const problem = urlProblem(url);
  if (problem) throw new WebhookError(problem);
  const f = o.fetchImpl ?? fetch;
  const attempts = (o.retries ?? 1) + 1;
  let last = "no attempt was made";
  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 10_000);
    try {
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal });
      if (res.ok) return;
      last = `the webhook answered HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break; // a 4xx will not get better by asking again
    } catch (e) {
      last = ctl.signal.aborted ? "the webhook did not answer in time" : `could not reach the webhook (${(e as Error).name})`;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, o.backoffMs ?? 1_000));
  }
  throw new WebhookError(last);
}
