import { describe, expect, test } from "bun:test";
import {
  argProblem,
  coerceTestArg,
  fieldTakesEmptyString,
  fieldUsesPicker,
} from "@/client/pages/resources/ToolTestModal";
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

// Round 2 of review. Two questions the dialog answered on its own and the runtime answers
// differently, both proven against `parseToolInputSchema`/`zodFor` rather than against my reading
// of them.

describe("argProblem", () => {
  test("a required field left blank is a problem, an optional one is not", () => {
    // On a type the empty string cannot satisfy. For a STRING it is a value, not a gap — see the
    // "the empty string, where the schema takes it" block below.
    expect(argProblem({ type: "integer", required: true }, "")).toEqual({
      kind: "missing",
    });
    expect(argProblem({ type: "integer", required: false }, "")).toBeNull();
  });

  test("and the runtime agrees: the declared schema refuses the blank one", () => {
    // The proof that "required means required" is not this file's opinion. The same declaration
    // through the runtime's own reader rejects an absent value and accepts an absent optional one.
    const req = parseToolInputSchema({ q: { type: "string", required: true } });
    const opt = parseToolInputSchema({
      q: { type: "string", required: false },
    });
    expect(req.safeParse({}).success).toBe(false);
    expect(opt.safeParse({}).success).toBe(true);
  });

  test("a value the type refuses is reported as the type problem, not as missing", () => {
    const p = argProblem({ type: "integer", required: true }, "3.5");
    expect(p?.kind).toBe("type");
    expect(p?.kind === "type" && p.got.reason).toBe("integer");
  });
});

describe("fieldUsesPicker", () => {
  test.each([
    [{ type: "boolean" }, true],
    [{ type: "enum", enumValues: ["gold", "silver"] }, true],
    // An enum with no declared values is legal, and `zodFor` reads it as a FREE STRING. A picker
    // built from that list offers "Leave out" and nothing else, so the field could never be filled.
    [{ type: "enum", enumValues: [] }, false],
    [{ type: "enum" }, false],
    [{ type: "string" }, false],
  ])("%p -> %p", (field, expected) => {
    expect(fieldUsesPicker(field as never)).toBe(expected);
  });

  test("and an empty enum really is a free string to the runtime", () => {
    const schema = parseToolInputSchema({
      tier: { type: "enum", enumValues: [], required: true },
    });
    expect(schema.safeParse({ tier: "anything at all" }).success).toBe(true);
  });
});

// Round 11 of review. An empty string is a VALUE for a string field — a PATCH that clears a
// provider field sends exactly that — and the dialog read every blank box as "nothing". A required
// string field could therefore not be submitted at all.
describe("the empty string, where the schema takes it", () => {
  test.each([
    [{ type: "string" }, true],
    // `zodFor`: an enum with no declared values falls back to a free string.
    [{ type: "enum", enumValues: [] }, true],
    [{ type: "enum", enumValues: ["a"] }, false],
    [{ type: "integer" }, false],
    [{ type: "number" }, false],
    [{ type: "boolean" }, false],
    [{ type: "array" }, false],
    [{ type: "object" }, false],
  ])("%p takes an empty string: %p", (field, expected) => {
    expect(fieldTakesEmptyString(field as never)).toBe(expected);
    // And the runtime agrees, which is the control: the same declaration through its own reader.
    const schema = parseToolInputSchema({
      q: { ...(field as object), required: true },
    });
    expect(schema.safeParse({ q: "" }).success).toBe(expected);
  });

  test("a required string left blank is a value, not a missing field", () => {
    // It used to be a dead end: reported missing, Send disabled, and no way to say "".
    expect(argProblem({ type: "string", required: true }, "")).toBeNull();
    // A required integer left blank is still missing — "" is not an integer.
    expect(argProblem({ type: "integer", required: true }, "")).toEqual({
      kind: "missing",
    });
  });
});
