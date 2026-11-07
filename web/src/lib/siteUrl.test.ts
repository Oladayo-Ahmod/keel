import { describe, expect, it } from "vitest";
import { SiteUrlError, isLocalHost, resolveSiteUrl } from "../../scripts/site-url.mjs";
import { siteUrl } from "./share";

describe("site url", () => {
  it("prefers NEXT_PUBLIC_SITE_URL over Vercel's production domain", () => {
    const env = { NEXT_PUBLIC_SITE_URL: "https://a.example", VERCEL_PROJECT_PRODUCTION_URL: "b.example" };
    expect(resolveSiteUrl(env, true).origin).toBe("https://a.example");
  });

  it("uses Vercel's bare production host with https", () => {
    expect(resolveSiteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "trozu.vercel.app" }, true).origin).toBe("https://trozu.vercel.app");
    expect(resolveSiteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "https://trozu.vercel.app" }, true).origin).toBe("https://trozu.vercel.app");
  });

  it("ignores empty and whitespace values", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "  ", VERCEL_PROJECT_PRODUCTION_URL: "b.example" }, true).origin).toBe("https://b.example");
  });

  it("falls back to localhost only outside production", () => {
    expect(resolveSiteUrl({}, false).origin).toBe("http://localhost:3000");
  });

  it("refuses to build for production with nothing set", () => {
    expect(() => resolveSiteUrl({}, true)).toThrow(SiteUrlError);
    expect(() => resolveSiteUrl({}, true)).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  it("refuses a local address in production, from either variable", () => {
    for (const bad of ["http://localhost:3000", "http://127.0.0.1:3100", "http://0.0.0.0", "http://[::1]:3000", "https://app.localhost", "http://LOCALHOST"]) {
      expect(() => resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: bad }, true), bad).toThrow(/no one else can reach/);
    }
    expect(() => resolveSiteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "localhost:3000" }, true)).toThrow(SiteUrlError);
  });

  it("allows a local address while developing", () => {
    expect(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "http://localhost:3100" }, false).origin).toBe("http://localhost:3100");
  });

  it("does not fall back to localhost for a value that is not a URL", () => {
    expect(() => resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "not a url" }, true)).toThrow(/not a valid URL/);
    expect(() => resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "not a url" }, false)).toThrow(/not a valid URL/);
  });

  it("rejects other schemes", () => {
    expect(() => resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "ftp://a.example" }, true)).toThrow(/http or https/);
  });

  it("does not mistake real hosts that start like local ones", () => {
    expect(isLocalHost("localhost.example.com")).toBe(false);
    expect(isLocalHost("127.example.com")).toBe(false);
    expect(isLocalHost("notlocalhost")).toBe(false);
    expect(isLocalHost("127.0.0.5")).toBe(true);
  });

  it("siteUrl treats NODE_ENV=production as a production build", () => {
    expect(() => siteUrl({ NODE_ENV: "production" })).toThrow(SiteUrlError);
    expect(siteUrl({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://a.example" }).origin).toBe("https://a.example");
    expect(siteUrl({ NODE_ENV: "development" }).origin).toBe("http://localhost:3000");
    expect(siteUrl({}).origin).toBe("http://localhost:3000");
  });
});
