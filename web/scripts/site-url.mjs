// The public address of the site, used for absolute share-image and preview URLs. One file, imported by next.config.mjs
// (so a production build fails early) and by src/lib/share.ts (so the app and the check can never disagree).

export class SiteUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = "SiteUrlError";
  }
}

/** Hosts that only mean something on the machine that serves them. */
export function isLocalHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * NEXT_PUBLIC_SITE_URL if set, else Vercel's production domain (VERCEL_PROJECT_PRODUCTION_URL, a bare host).
 * In development with neither set it is http://localhost:3000. In a production build it never is: a missing,
 * unreadable or local address throws, because a share image that points at localhost is broken for everyone else.
 */
export function resolveSiteUrl(env, production) {
  const explicit = (env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  const vercel = (env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  let raw = explicit;
  let from = "NEXT_PUBLIC_SITE_URL";
  if (!raw && vercel) {
    raw = /^https?:\/\//i.test(vercel) ? vercel : `https://${vercel}`;
    from = "VERCEL_PROJECT_PRODUCTION_URL";
  }
  if (!raw) {
    if (!production) return new URL("http://localhost:3000");
    throw new SiteUrlError(
      "No public site URL for a production build. Set NEXT_PUBLIC_SITE_URL to the deployed address (for example https://your-domain.example), or deploy on Vercel with system environment variables exposed so VERCEL_PROJECT_PRODUCTION_URL is set.",
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SiteUrlError(`${from} is not a valid URL: "${raw}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SiteUrlError(`${from} must be an http or https address, got "${raw}".`);
  if (production && isLocalHost(url.hostname)) {
    throw new SiteUrlError(`${from} resolves to ${url.hostname}, which no one else can reach. A production build needs the public address.`);
  }
  return url;
}
