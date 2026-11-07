#!/usr/bin/env node
import { run } from "./run.js";

// Settings are environment variables (see README). No key is read or needed: this only reads the chain.
process.exitCode = await run({
  env: process.env,
  argv: process.argv.slice(2),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
