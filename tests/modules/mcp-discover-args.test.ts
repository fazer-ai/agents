import { describe, expect, test } from "bun:test";
import { summarizeToolArgs } from "@/modules/mcp-connections/service";

// summarizeToolArgs turns a tool's raw JSON Schema (DynamicStructuredTool.schema) into the flat
// arg list the discover UI renders: name + readable type label + description + required flag.
describe("summarizeToolArgs", () => {
  test("maps properties with type, description and required flag", () => {
    const args = summarizeToolArgs({
      type: "object",
      properties: {
        id: { type: "string", description: "the license id" },
        verbose: { type: "boolean" },
      },
      required: ["id"],
    });
    expect(args).toEqual([
      {
        name: "id",
        type: "string",
        description: "the license id",
        required: true,
      },
      { name: "verbose", type: "boolean", description: null, required: false },
    ]);
  });

  test("enum → 'enum', array → 'item[]', type union → 'a | b'", () => {
    const args = summarizeToolArgs({
      type: "object",
      properties: {
        status: { enum: ["open", "closed"], type: "string" },
        tags: { type: "array", items: { type: "string" } },
        either: { type: ["string", "number"] },
        loose: { type: "array" },
      },
    });
    const byName = Object.fromEntries(args.map((a) => [a.name, a.type]));
    expect(byName.status).toBe("enum");
    expect(byName.tags).toBe("string[]");
    expect(byName.either).toBe("string | number");
    expect(byName.loose).toBe("array");
  });

  // The adapter hands the schema over as the server declared it, so arguments behind a root `$ref`
  // or `allOf`, and a property that is a `$ref`, are resolved for the summary.
  test("resolves local $ref and allOf", () => {
    const args = summarizeToolArgs({
      $defs: {
        base: {
          type: "object",
          properties: { id: { type: "string", description: "the id" } },
          required: ["id"],
        },
        item: { type: "object", description: "an item" },
      },
      allOf: [
        { $ref: "#/$defs/base" },
        {
          type: "object",
          properties: {
            item: { $ref: "#/$defs/item" },
            note: { $ref: "#/$defs/item", description: "own words" },
          },
          required: ["item"],
        },
      ],
    });
    expect(args).toEqual([
      { name: "id", type: "string", description: "the id", required: true },
      { name: "item", type: "object", description: "an item", required: true },
      {
        name: "note",
        type: "object",
        description: "own words",
        required: false,
      },
    ]);
    expect(
      summarizeToolArgs({
        $ref: "#/definitions/root",
        definitions: {
          root: { type: "object", properties: { q: { type: "string" } } },
        },
      }),
    ).toEqual([
      { name: "q", type: "string", description: null, required: false },
    ]);
  });

  test("keeps the keywords declared beside a $ref", () => {
    expect(
      summarizeToolArgs({
        $ref: "#/$defs/empty",
        $defs: { empty: { type: "object" } },
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
    ).toEqual([
      { name: "q", type: "string", description: null, required: true },
    ]);
  });

  test("anyOf and oneOf branches add their arguments, required only when every branch requires it", () => {
    const args = summarizeToolArgs({
      anyOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      ],
    });
    expect(args).toEqual([
      { name: "a", type: "string", description: null, required: true },
      { name: "b", type: "number", description: null, required: false },
    ]);
    expect(
      summarizeToolArgs({
        oneOf: [
          { properties: { x: { type: "string" } }, required: ["x"] },
          { properties: { y: { type: "string" } }, required: ["y"] },
        ],
      }).map((a) => [a.name, a.required]),
    ).toEqual([
      ["x", false],
      ["y", false],
    ]);
  });

  test("a property's own keywords beside a $ref win over the target's", () => {
    expect(
      summarizeToolArgs({
        $defs: { empty: {}, word: { type: "number", description: "far" } },
        properties: {
          a: { $ref: "#/$defs/empty", type: "string" },
          b: { $ref: "#/$defs/word", type: "string" },
        },
      }),
    ).toEqual([
      { name: "a", type: "string", description: null, required: false },
      { name: "b", type: "string", description: "far", required: false },
    ]);
  });

  // NOTE: unbounded, this shape is exponential in the depth limit and never returns.
  test("repeated recursive $refs stay bounded", () => {
    const started = performance.now();
    const args = summarizeToolArgs({
      properties: { q: { type: "string" } },
      allOf: Array.from({ length: 40 }, () => ({ $ref: "#" })),
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(args.map((a) => a.name)).toEqual(["q"]);
    const fanOut: Record<string, unknown> = {
      d9: { properties: { leaf: { type: "string" } } },
    };
    for (let i = 0; i < 9; i++)
      fanOut[`d${i}`] = {
        allOf: Array.from({ length: 10 }, () => ({
          $ref: `#/$defs/d${i + 1}`,
        })),
      };
    const wide = performance.now();
    expect(
      summarizeToolArgs({ $defs: fanOut, $ref: "#/$defs/d0" }).map(
        (a) => a.name,
      ),
    ).toEqual(["leaf"]);
    expect(performance.now() - wide).toBeLessThan(2000);
  });

  test("a $ref cycle or a dangling $ref does not hang or throw", () => {
    expect(
      summarizeToolArgs({
        $ref: "#/$defs/a",
        $defs: { a: { $ref: "#/$defs/a" } },
      }),
    ).toEqual([]);
    expect(
      summarizeToolArgs({
        type: "object",
        properties: { x: { $ref: "#/nope" } },
      }),
    ).toEqual([{ name: "x", type: null, description: null, required: false }]);
  });

  test("non-object schema or no properties → no args", () => {
    expect(summarizeToolArgs(null)).toEqual([]);
    expect(summarizeToolArgs({ type: "object" })).toEqual([]);
    expect(summarizeToolArgs("nope")).toEqual([]);
    expect(summarizeToolArgs({ properties: {} })).toEqual([]);
  });

  test("unknown / missing type yields a null type label", () => {
    const args = summarizeToolArgs({
      properties: { freeform: { description: "anything" } },
    });
    expect(args).toEqual([
      {
        name: "freeform",
        type: null,
        description: "anything",
        required: false,
      },
    ]);
  });
});
