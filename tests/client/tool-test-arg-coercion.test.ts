import { describe, expect, test } from "bun:test";
import { coerceTestArg } from "@/client/pages/resources/ToolTestModal";
import { parseToolInputSchema } from "@/graph/tools/http";

// Round 1 of review, finding 1. The test dialog collects text and the runtime validates the
// argument against the field's DECLARED zod type before fetching, so five of the seven declared
// types would fail the call on a schema error and never reach the API.
//
// The control is not this table's shape but its agreement with `parseToolInputSchema`, which builds
// the very schema `buildHttpTool` validates against: a coercion that only satisfies its own author
// is the same defect one layer up.

describe("coerceTestArg", () => {
  test.each([
    ["string", undefined, "abc", "abc"],
    ["integer", undefined, " 42 ", 42],
    ["number", undefined, "3.5", 3.5],
    ["boolean", undefined, "true", true],
    ["boolean", undefined, "false", false],
    ["enum", undefined, "gold", "gold"],
    ["array", "string", '["a","b"]', ["a", "b"]],
    ["array", "string", "a, b", ["a", "b"]],
    ["array", "integer", "1, 2, 3", [1, 2, 3]],
    ["array", "number", "[1.5, 2]", [1.5, 2]],
    ["object", undefined, '{"k": 1}', { k: 1 }],
  ])("%s(%s) from %p", (type, itemType, raw, expected) => {
    const got = coerceTestArg({ type, itemType }, raw as string);
    expect(got.ok).toBe(true);
    expect(got.ok && got.value).toEqual(expected);
  });

  test.each([
    ["integer", undefined, "3.5"],
    ["integer", undefined, "abc"],
    ["integer", undefined, ""],
    ["number", undefined, "abc"],
    ["number", undefined, ""],
    ["boolean", undefined, "yes"],
    ["array", "integer", "a, b"],
    ["object", undefined, "[1,2]"],
    ["object", undefined, "not json"],
  ])("refuses %s(%s) from %p", (type, itemType, raw) => {
    const got = coerceTestArg({ type, itemType }, raw as string);
    expect(got.ok).toBe(false);
  });

  // THE control: whatever this produces has to satisfy the schema the runtime actually builds.
  test("every coerced value passes the schema buildHttpTool validates against", () => {
    const declared = {
      s: { type: "string" },
      i: { type: "integer" },
      n: { type: "number" },
      b: { type: "boolean" },
      e: { type: "enum", enumValues: ["gold", "silver"] },
      a: { type: "array", itemType: "integer" },
      o: { type: "object" },
    } as const;
    const typed: Record<string, string> = {
      s: "hello",
      i: "42",
      n: "3.5",
      b: "true",
      e: "gold",
      a: "1, 2",
      o: '{"k":1}',
    };
    const args: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(declared)) {
      const got = coerceTestArg(
        {
          type: spec.type,
          itemType: (spec as { itemType?: string }).itemType,
        },
        typed[name] as string,
      );
      expect(got.ok).toBe(true);
      if (got.ok) args[name] = got.value;
    }
    expect(parseToolInputSchema(declared).safeParse(args).success).toBe(true);
    // And the control the other way: the raw strings this dialog used to send do NOT pass, which is
    // the defect being fixed rather than a property of the fix.
    expect(parseToolInputSchema(declared).safeParse(typed).success).toBe(false);
  });
});
