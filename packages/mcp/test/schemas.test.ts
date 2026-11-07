import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "../src/server.js";
import { actionInputShape, actionSchemas, toolInputs } from "../src/tools.js";
import { fixture } from "./fixture.js";

/**
 * Guards the reasoning in README.md about the zod advisory GHSA-mrhx-c7xc-m3w5 (memory exhaustion on
 * oversized collections): our own input schemas hold no array, set, map, record, tuple or open object, so
 * a caller cannot hand them a large collection to validate. If one is added, these tests fail and the
 * advisory text has to be revisited.
 */

type Def = { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; options?: z.ZodTypeAny[]; shape?: () => Record<string, z.ZodTypeAny>; catchall?: z.ZodTypeAny; unknownKeys?: string; in?: z.ZodTypeAny; out?: z.ZodTypeAny };

const LEAVES = new Set(["ZodString", "ZodNumber", "ZodBigInt", "ZodBoolean", "ZodLiteral", "ZodEnum", "ZodNativeEnum"]);
const WRAPPERS = new Set(["ZodOptional", "ZodNullable", "ZodDefault", "ZodReadonly", "ZodCatch", "ZodBranded"]);

/** Every way a schema in `s` could hold a collection, as a list of paths. Empty means none. */
export function collections(s: z.ZodTypeAny, path = "$"): string[] {
  const d = s._def as Def;
  const t = d.typeName ?? "?";
  if (LEAVES.has(t)) return [];
  if (WRAPPERS.has(t)) return collections(d.innerType!, path);
  if (t === "ZodEffects") return collections(d.schema!, path);
  if (t === "ZodPipeline") return [...collections(d.in!, path), ...collections(d.out!, path)];
  if (t === "ZodUnion" || t === "ZodDiscriminatedUnion") return d.options!.flatMap((o, i) => collections(o, `${path}|${i}`));
  if (t === "ZodObject") {
    const open = d.catchall && d.catchall._def.typeName !== "ZodNever" ? [`${path} has a catchall`] : [];
    const passthrough = d.unknownKeys === "passthrough" ? [`${path} passes unknown keys through`] : [];
    return [...open, ...passthrough, ...Object.entries(d.shape!()).flatMap(([k, v]) => collections(v, `${path}.${k}`))];
  }
  // arrays, sets, maps, records, tuples, any, unknown, lazy, intersections, and anything this walker has not seen
  return [`${path} is ${t}`];
}

/** The same check on a JSON Schema, as a client sees it from tools/list. */
function jsonCollections(node: unknown, path = "$"): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as Record<string, unknown>;
  const out: string[] = [];
  if (n.type === "array" || "items" in n || "prefixItems" in n) out.push(`${path} is an array`);
  if ("patternProperties" in n) out.push(`${path} has patternProperties`);
  if (n.type === "object" && n.additionalProperties !== false) out.push(`${path} is an open object`);
  for (const [k, v] of Object.entries(n)) {
    if (Array.isArray(v)) v.forEach((x, i) => out.push(...jsonCollections(x, `${path}.${k}[${i}]`)));
    else if (v && typeof v === "object") out.push(...jsonCollections(v, `${path}.${k}`));
  }
  return out;
}

describe("no input schema takes a collection", () => {
  it("none of the read tools' strict schemas does", () => {
    for (const [name, schema] of Object.entries(toolInputs)) expect(collections(schema), name).toEqual([]);
  });

  it("none of the per-action build_tx schemas does", () => {
    for (const [name, schema] of Object.entries(actionSchemas)) expect(collections(schema), name).toEqual([]);
  });

  it("nor does the argument shape the model is shown for build_tx and simulate_action", () => {
    for (const [name, schema] of Object.entries(actionInputShape)) expect(collections(schema), name).toEqual([]);
  });

  it("and the JSON Schema each tool publishes has no array or open object", async () => {
    const f = fixture();
    const server = createServer(f.trozu);
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    for (const t of tools) expect(jsonCollections(t.inputSchema), t.name).toEqual([]);
  });

  it("the check itself catches an array, a record, an open object and a nested one", () => {
    expect(collections(z.object({ a: z.array(z.string()) }))).toEqual(["$.a is ZodArray"]);
    expect(collections(z.object({ a: z.record(z.string()).optional() }))).toEqual(["$.a is ZodRecord"]);
    expect(collections(z.object({ a: z.string() }).passthrough())).toEqual(["$ passes unknown keys through"]);
    expect(collections(z.object({ a: z.union([z.string(), z.object({ b: z.set(z.string()) })]) }))).toEqual(["$.a|1.b is ZodSet"]);
    expect(collections(z.object({ a: z.string().transform((s) => s.length).pipe(z.number()) }))).toEqual([]);
    expect(jsonCollections({ type: "object", additionalProperties: false, properties: { a: { type: "array", items: { type: "string" } } } })).toEqual(["$.properties.a is an array"]);
  });
});
