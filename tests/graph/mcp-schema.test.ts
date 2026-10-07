import { describe, expect, test } from "bun:test";
import { declarationSchema } from "@/graph/tools/mcp-schema";

// The declaration an MCP tool's input schema gets in front of the model: local `$ref`s inlined and
// composition folded into one object, with nothing the provider would refuse at the root.
describe("declarationSchema", () => {
  test("inlines local $refs, keeps a property's own keywords, drops the definitions", () => {
    expect(
      declarationSchema({
        type: "object",
        properties: {
          item: { $ref: "#/$defs/item", description: "own words" },
          legacy: { $ref: "#/definitions/word" },
        },
        $defs: {
          item: {
            type: "object",
            properties: { sku: { type: "string" } },
            description: "far",
          },
        },
        definitions: { word: { type: "string" } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        item: {
          type: "object",
          properties: { sku: { type: "string" } },
          description: "own words",
        },
        legacy: { type: "string" },
      },
    });
  });

  test("a root allOf is merged, overlapping arguments keep every keyword", () => {
    expect(
      declarationSchema({
        allOf: [
          {
            type: "object",
            properties: { id: { type: "string", description: "the id" } },
            required: ["id"],
          },
          {
            properties: { id: { minLength: 3 }, n: { type: "number" } },
            required: ["n"],
          },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        id: { type: "string", description: "the id", minLength: 3 },
        n: { type: "number" },
      },
      required: ["id", "n"],
    });
  });

  test("a root anyOf or oneOf becomes one object, required only where every branch requires", () => {
    for (const key of ["anyOf", "oneOf"]) {
      const declared = declarationSchema({
        [key]: [
          {
            type: "object",
            properties: { a: { type: "string" }, b: { type: "number" } },
            required: ["a", "b"],
          },
          {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
        ],
      }) as Record<string, unknown>;
      expect(declared).toEqual({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a"],
      });
    }
  });

  test("conditionals add their properties; not, $schema and unevaluatedProperties go", () => {
    expect(
      declarationSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { kind: { enum: ["a", "b"] } },
        if: { properties: { kind: { const: "a" } } },
        // biome-ignore lint/suspicious/noThenProperty: a JSON Schema conditional, not a thenable
        then: { properties: { x: { type: "string" } }, required: ["x"] },
        else: { properties: { y: { type: "string" } } },
        not: { required: ["z"] },
        unevaluatedProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        kind: { enum: ["a", "b"] },
        x: { type: "string" },
        y: { type: "string" },
      },
      required: ["x"],
    });
  });

  test("nested composition is folded inside properties, items and additionalProperties", () => {
    const declared = declarationSchema({
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { allOf: [{ properties: { k: { type: "string" } } }] },
        },
        map: {
          type: "object",
          additionalProperties: {
            anyOf: [{ properties: { v: { type: "number" } } }],
          },
        },
      },
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(declared.properties.list?.items).toEqual({
      type: "object",
      properties: { k: { type: "string" } },
    });
    expect(declared.properties.map?.additionalProperties).toEqual({
      type: "object",
      properties: { v: { type: "number" } },
    });
  });

  test("a recursive $ref stops at an open object, and a schema with no properties gets an empty map", () => {
    expect(
      declarationSchema({
        type: "object",
        properties: { node: { $ref: "#/$defs/node" } },
        $defs: {
          node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/node" } },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        node: { type: "object", properties: { next: { type: "object" } } },
      },
    });
    expect(declarationSchema({ type: "object" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  // NOTE: inlined without a bound, this fan-out of shared definitions builds 10^9 nodes; with one,
  // the arguments beside it still reach the declaration folded.
  test("shared definitions fanning out stay bounded", () => {
    const defs: Record<string, unknown> = { d9: { type: "string" } };
    for (let i = 0; i < 9; i++)
      defs[`d${i}`] = {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 10 }, (_, j) => [
            `p${j}`,
            { $ref: `#/$defs/d${i + 1}` },
          ]),
        ),
      };
    const started = performance.now();
    const declared = declarationSchema({
      type: "object",
      properties: { root: { $ref: "#/$defs/d0" }, q: { type: "string" } },
      required: ["q"],
      allOf: [{ properties: { n: { type: "number" } } }],
      $defs: defs,
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(JSON.stringify(declared).length).toBeLessThan(1_000_000);
    expect(declared).toMatchObject({
      type: "object",
      properties: { q: { type: "string" }, n: { type: "number" } },
      required: ["q"],
    });
    expect(JSON.stringify(declared)).not.toContain("allOf");
  });

  test("the server's schema is not mutated", () => {
    const listed = {
      allOf: [{ properties: { a: { $ref: "#/$defs/a" } } }],
      $defs: { a: { type: "string" } },
    };
    const before = structuredClone(listed);
    declarationSchema(listed);
    expect(listed).toEqual(before);
  });
});
