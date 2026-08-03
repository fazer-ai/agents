import { describe, expect, test } from "bun:test";
import {
  CONTEXT_VAR_NAMES,
  compactFromJsonSchema,
  isJsonSchemaShape,
  normalizeInputSchemaShape,
  normalizeToolShapes,
} from "@/modules/tool-definitions/normalize";

describe("isJsonSchemaShape", () => {
  test("recognizes the standard {properties, required} shape", () => {
    expect(
      isJsonSchemaShape({
        required: ["valor"],
        properties: { valor: { type: "string" } },
      }),
    ).toBe(true);
  });

  test("recognizes {type: 'object', properties}", () => {
    expect(
      isJsonSchemaShape({
        type: "object",
        properties: { q: { type: "string" } },
      }),
    ).toBe(true);
  });

  test("recognizes a bare {properties} (keys all JSON Schema keywords)", () => {
    expect(isJsonSchemaShape({ properties: { q: { type: "string" } } })).toBe(
      true,
    );
  });

  test("a compact map is NOT JSON Schema", () => {
    expect(
      isJsonSchemaShape({
        valor: { type: "string", required: true },
        q: { type: "string" },
      }),
    ).toBe(false);
  });

  test("pathological compact field literally named 'properties' stays compact", () => {
    // NOTE: {properties: {type: "object"}} has a FieldSpec (string values) under `properties`,
    // not a JSON Schema properties map of objects.
    expect(isJsonSchemaShape({ properties: { type: "object" } })).toBe(false);
  });

  test("non-objects and empty are not JSON Schema", () => {
    expect(isJsonSchemaShape(null)).toBe(false);
    expect(isJsonSchemaShape("x")).toBe(false);
    expect(isJsonSchemaShape({})).toBe(false);
  });
});

describe("prototype-safe output maps", () => {
  test('a field literally named "__proto__" survives conversion as an own key', () => {
    // NOTE: JSON.parse creates "__proto__" as an OWN key; a plain out[name] assignment would
    // invoke the inherited setter and silently drop it.
    const raw = JSON.parse(
      '{"properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
    );
    const out = compactFromJsonSchema(raw);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({
      type: "string",
      required: true,
    });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  test('a query param named "__proto__" survives normalization as an own key', () => {
    const { shapes } = normalizeToolShapes({
      query: JSON.parse('{"__proto__":"static-value"}'),
    });
    const query = shapes.query as Record<string, unknown>;
    expect(Object.hasOwn(query, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(query, "__proto__")?.value).toBe(
      "static-value",
    );
  });
});

describe("compactFromJsonSchema", () => {
  test("converts scalars, required flags and descriptions", () => {
    const out = compactFromJsonSchema({
      type: "object",
      required: ["a", "n"],
      properties: {
        a: { type: "string", description: "the a" },
        n: { type: "integer" },
        opt: { type: "boolean" },
      },
    });
    expect(out).toEqual({
      a: { type: "string", description: "the a", required: true },
      n: { type: "integer", required: true },
      opt: { type: "boolean" },
    });
  });

  test("non-string enums degrade to the base scalar type (never a free string that rejects them)", () => {
    const warnings: string[] = [];
    const out = compactFromJsonSchema(
      {
        properties: {
          nivel: { enum: [1, 2, 3] },
          fator: { enum: [1.5, 2.5] },
          ativo: { enum: [true, false] },
          misto: { enum: ["a", 1] },
        },
      },
      warnings,
    );
    expect(out.nivel).toEqual({ type: "integer" });
    expect(out.fator).toEqual({ type: "number" });
    expect(out.ativo).toEqual({ type: "boolean" });
    expect(out.misto).toEqual({ type: "string" });
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('"nivel"');
    // NOTE: the lossy-enum warnings surface through normalizeToolShapes with the conversion notice.
    const { warnings: shapeWarnings } = normalizeToolShapes({
      inputSchema: { properties: { nivel: { enum: [1, 2] } } },
    });
    expect(shapeWarnings.some((w) => w.includes("JSON Schema"))).toBe(true);
    expect(shapeWarnings.some((w) => w.includes('"nivel"'))).toBe(true);
  });

  test("converts enum, array-of-scalars and degrades nested shapes to object", () => {
    const out = compactFromJsonSchema({
      properties: {
        status: { enum: ["open", "closed"] },
        ids: { type: "array", items: { type: "integer" } },
        nested: { type: "object", properties: { x: { type: "string" } } },
        anyof: { anyOf: [{ type: "string" }, { type: "integer" }] },
        untyped: {},
      },
    });
    expect(out.status).toEqual({
      type: "enum",
      enumValues: ["open", "closed"],
    });
    expect(out.ids).toEqual({ type: "array", itemType: "integer" });
    expect(out.nested).toEqual({ type: "object" });
    expect(out.anyof).toEqual({ type: "object" });
    expect(out.untyped).toEqual({ type: "string" });
  });

  test("lossy structural conversions warn; faithful ones stay silent", () => {
    const warnings: string[] = [];
    const out = compactFromJsonSchema(
      {
        properties: {
          docs: { type: "array", items: { type: "object" } },
          bare_list: { type: "array" },
          nested: { type: "object", properties: { x: { type: "string" } } },
          plain_obj: { type: "object" },
          either: { anyOf: [{ type: "string" }, { type: "integer" }] },
        },
      },
      warnings,
    );
    expect(out.docs).toEqual({ type: "array", itemType: "string" });
    expect(out.plain_obj).toEqual({ type: "object" });
    const joined = warnings.join("\n");
    expect(joined).toContain('"docs"');
    expect(joined).toContain('"nested"');
    expect(joined).toContain('"either"');
    // NOTE: faithful mappings never warn: a bare {type: "object"} and an untyped array.
    expect(joined).not.toContain('"plain_obj"');
    expect(joined).not.toContain('"bare_list"');
  });
});

describe("normalizeToolShapes — single-brace placeholders", () => {
  test("rewrites {field} to {{field}} only for declared fields, context vars and secret", () => {
    const { shapes, warnings } = normalizeToolShapes({
      urlTemplate: "https://api.example.com/v1/cnpj/{cnpj}?k={secret}",
      inputSchema: { cnpj: { type: "string", required: true } },
      query: { nome: "{nome}", conv: "{conversation_id}" },
      headers: { "X-Nome": "{cnpj}" },
      body: { mode: "raw", raw: '{"doc":"{cnpj}","lit":"{unknown_token}"}' },
    });
    expect(shapes.urlTemplate).toBe(
      "https://api.example.com/v1/cnpj/{{cnpj}}?k={{secret}}",
    );
    expect(shapes.query).toEqual({
      nome: "{nome}",
      conv: "{{conversation_id}}",
    });
    expect(shapes.headers).toEqual({ "X-Nome": "{{cnpj}}" });
    expect(shapes.body).toEqual({
      mode: "raw",
      raw: '{"doc":"{{cnpj}}","lit":"{unknown_token}"}',
    });
    expect(warnings.join(" ")).toContain("{nome}");
    expect(warnings.join(" ")).toContain("{unknown_token}");
  });

  test("is idempotent: {{field}} and the ambiguous halves are untouched", () => {
    const tpl = "https://x.example/a/{{id}}/b/{id}}/c/{{id}";
    const once = normalizeToolShapes({
      urlTemplate: tpl,
      inputSchema: { id: { type: "string" } },
    }).shapes.urlTemplate as string;
    const twice = normalizeToolShapes({
      urlTemplate: once,
      inputSchema: { id: { type: "string" } },
    }).shapes.urlTemplate as string;
    expect(once).toBe("https://x.example/a/{{id}}/b/{id}}/c/{{id}");
    expect(twice).toBe(once);
  });

  test("kv body row values are rewritten; non-string values pass through", () => {
    const { shapes } = normalizeToolShapes({
      inputSchema: { v: { type: "number" } },
      body: {
        mode: "kv",
        rows: [
          { key: "v", value: "{v}" },
          { key: "n", value: 7 },
        ],
      },
    });
    expect(shapes.body).toEqual({
      mode: "kv",
      rows: [
        { key: "v", value: "{{v}}" },
        { key: "n", value: 7 },
      ],
    });
  });

  test("legacy fixed-field values inside the schema are rewritten too", () => {
    const { shapes } = normalizeToolShapes({
      inputSchema: {
        amount: { type: "number", required: true },
        conv: { source: "fixed", value: "{conversation_id}" },
      },
    });
    expect(shapes.inputSchema).toEqual({
      amount: { type: "number", required: true },
      conv: { source: "fixed", value: "{{conversation_id}}" },
    });
  });

  test("update patch: allowlist comes from the current row when the patch omits the schema", () => {
    const { shapes } = normalizeToolShapes(
      { urlTemplate: "https://x.example/{cnpj}" },
      { inputSchema: { cnpj: { type: "string", required: true } } },
    );
    expect(shapes.urlTemplate).toBe("https://x.example/{{cnpj}}");
    expect(shapes.inputSchema).toBeUndefined();
  });

  test("JSON Schema conversion feeds the allowlist in the same pass", () => {
    const { shapes, warnings } = normalizeToolShapes({
      urlTemplate: "https://x.example/anything/{valor}",
      inputSchema: {
        required: ["valor"],
        properties: { valor: { type: "string" } },
      },
    });
    expect(shapes.inputSchema).toEqual({
      valor: { type: "string", required: true },
    });
    expect(shapes.urlTemplate).toBe("https://x.example/anything/{{valor}}");
    expect(warnings.some((w) => w.includes("JSON Schema"))).toBe(true);
  });

  test("only patched keys are returned", () => {
    const { shapes } = normalizeToolShapes({
      urlTemplate: "https://x.example/y",
    });
    expect(Object.keys(shapes)).toEqual(["urlTemplate"]);
  });
});

describe("normalizeInputSchemaShape / CONTEXT_VAR_NAMES", () => {
  test("converts JSON Schema on read, passes compact through", () => {
    expect(
      normalizeInputSchemaShape({
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
    ).toEqual({ q: { type: "string", required: true } });
    const compact = { q: { type: "string" } };
    expect(normalizeInputSchemaShape(compact)).toBe(compact);
    expect(normalizeInputSchemaShape(null)).toEqual({});
  });

  test("context var list covers the runtime's interpolation names", () => {
    for (const name of [
      "conversation_id",
      "message_id",
      "contact_name",
      "agent_name",
    ]) {
      expect(CONTEXT_VAR_NAMES as readonly string[]).toContain(name);
    }
  });
});
