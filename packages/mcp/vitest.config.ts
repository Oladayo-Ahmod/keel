import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// tests run against the sdk's source, so they do not need it built first
export default defineConfig({
  resolve: { alias: { "@trozu/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)) } },
});
