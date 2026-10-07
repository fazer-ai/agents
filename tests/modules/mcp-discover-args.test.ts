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
