import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { resolveSiteUrl } from "./scripts/site-url.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // always inline the test-wallet flag ("0" unless a test build sets it), so a normal build removes the
  // connector module instead of leaving a runtime check that keeps it in the bundle
  env: { NEXT_PUBLIC_E2E: process.env.NEXT_PUBLIC_E2E === "1" ? "1" : "0" },
  reactStrictMode: true,
  // the wallet round trip builds a test-only variant next to the real one
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Passport and the orangekit packages it builds on ship some TypeScript source,
  // and wallet libraries pull in node-only optional dependencies.
  transpilePackages: [
    "@mezo-org/passport",
    "@mezo-org/orangekit",
    "@mezo-org/orangekit-smart-account",
    "@mezo-org/orangekit-contracts",
    "@mezo-org/sign-in-with-wallet",
    "@mezo-org/mezo-clay",
  ],
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false };
    config.externals = [...(config.externals || []), "pino-pretty", "lokijs", "encoding"];
    return config;
  },
};

// a production build without a real public address would ship share images that point at localhost, so it stops here
export default function config(phase) {
  if (phase === PHASE_PRODUCTION_BUILD) resolveSiteUrl(process.env, true);
  return nextConfig;
}
