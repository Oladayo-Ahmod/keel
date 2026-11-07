import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = readdirSync(src).filter((f) => f.endsWith(".ts"));
const all = files.map((f) => [f, readFileSync(join(src, f), "utf8")] as const);

/** A static guard: the server's own code has no way to sign or send, and reads no secret from the environment. */
describe("the server cannot sign or send", () => {
  const banned = [
    "privateKey",
    "privateKeyToAccount",
    "mnemonic",
    "mnemonicToAccount",
    "signTransaction",
    "signMessage",
    "signTypedData",
    "sendTransaction",
    "sendRawTransaction",
    "writeContract",
    "createWalletClient",
    "walletClient",
    "eth_sendTransaction",
    "eth_sendRawTransaction",
  ];

  it.each(banned)("never mentions %s", (word) => {
    for (const [f, text] of all) expect(text.includes(word), `${f} mentions ${word}`).toBe(false);
  });

  it("reads only TROZU_RPC_URL from the environment", () => {
    const seen = new Set<string>();
    for (const [, text] of all) for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) seen.add(m[1]!);
    expect([...seen]).toEqual(["TROZU_RPC_URL"]);
  });
});
