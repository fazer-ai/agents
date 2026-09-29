import { describe, expect, test } from "bun:test";
import { z } from "zod";

// WHY A TOOL RULE CANNOT BE NAMED `__proto__`. `agent_settings_set` ignores a `{"__proto__": null}`
// tombstone, so a stored entry could never be deleted; two halves keep it from being stored. Here:
// the key does not survive any zod object rebuild, so no write surface carries it. In
// ./agent-transfer.test.ts: an agent import copies the settings bag verbatim past both, and Prisma
// rebuilds the JSON so the value never reaches Postgres. If either changes, re-derive the conclusion.
const CANDIDATES = [
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "prototype",
  "__defineGetter__",
  "handoff_to_human",
];

function ownKeysAfter(parse: (v: unknown) => unknown): string[] {
  const input = JSON.parse(
    `{${CANDIDATES.map((k) => `"${k}":{"a":1}`).join(",")}}`,
  );
  return Object.keys(parse(input) as object);
}

describe("which tool names a write surface can carry", () => {
  // MOST prototype-flavoured names are fine, and that is the useful half of this result: they arrive
  // as ordinary own properties and both runtime maps are null-prototype, so they never resolve
  // to anything inherited. `__proto__` is the single name where the surfaces disagree with storage.
  test("zod drops `__proto__` on rebuild and keeps every other prototype-ish name", () => {
    const loose = ownKeysAfter((v) => z.looseObject({}).parse(v));
    const record = ownKeysAfter((v) =>
      z.record(z.string(), z.unknown()).parse(v),
    );
    expect(CANDIDATES.filter((k) => !loose.includes(k))).toEqual(["__proto__"]);
    // Both shapes, because the two ends use different ones: the MCP blocks are loose objects and an
    // agent bundle's `settings` is a record.
    expect(CANDIDATES.filter((k) => !record.includes(k))).toEqual([
      "__proto__",
    ]);
  });

  // NOTE: the other half of the same fact, and why the import path is tested separately:
  // JSON.parse and an object SPREAD both keep the key as an own property, so it travels through
  // everything between the schema and the database.
  test("JSON.parse and spread both preserve what zod drops", () => {
    const raw = JSON.parse('{"__proto__":{"a":1},"handoff_to_human":{"a":1}}');
    expect(Object.keys(raw)).toContain("__proto__");
    expect(Object.keys({ ...raw })).toContain("__proto__");
  });

  // NOTE: a `z.unknown()` VALUE is passed by reference, which is why the import needs its own test: the
  // record rebuilds `settings` itself and leaves each block's own keys exactly as they arrived.
  test("a record rebuilds the bag but not the blocks inside it", () => {
    const bundle = JSON.parse(
      '{"toolPreconditions":{"__proto__":{"a":1},"handoff_to_human":{"a":1}}}',
    );
    const parsed = z.record(z.string(), z.unknown()).parse(bundle) as Record<
      string,
      unknown
    >;
    expect(
      Object.keys(parsed.toolPreconditions as Record<string, unknown>),
    ).toContain("__proto__");
  });
});
