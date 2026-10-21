/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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

export default nextConfig;
