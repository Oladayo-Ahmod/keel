// Fails if the test-only wallet connector ended up in a production build.
//   npm run build && node scripts/check-no-e2e.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? join(new URL("..", import.meta.url).pathname, ".next");
const markers = ["__e2eRequest", "E2E burner"];
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(js|html|json|map)$/.test(name) && s.size < 20_000_000) {
      const text = readFileSync(p, "utf8");
      for (const m of markers) if (text.includes(m)) hits.push(`${p}: ${m}`);
    }
  }
}
walk(root);
if (hits.length) {
  console.error("test-only wallet code found in the build:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`no e2e wallet code in ${root}`);
