import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";
import { compactToolSchema } from "@/modules/mcp/tool-listing";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

async function listedSchemas(
  role: VerifiedToken["role"],
): Promise<Map<string, Record<string, unknown>>> {
  const principal: VerifiedToken = {
    userId: 1n,
    tenantId: role === "SUPER_ADMIN" ? null : 1n,
    role,
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    clientId: "c",
    jti: "j",
  } as VerifiedToken;
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "listing-check", version: "0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(
    tools.map((t) => [t.name, t.inputSchema as Record<string, unknown>]),
  );
}

// What zod emits for the SDK, which converts every input schema with target draft-07.
function asSdkEmits(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<
    string,
    unknown
  >;
}

describe("tools/list publishes each input schema without what carries nothing", () => {
  for (const role of ["TENANT_ADMIN", "SUPER_ADMIN"] as const) {
    test(`no tool declares the dialect or an empty additionalProperties (${role})`, async () => {
      const schemas = await listedSchemas(role);
      expect(schemas.size).toBeGreaterThan(100);
      const declaring = [...schemas]
        .filter(([, s]) => "$schema" in s)
        .map(([n]) => n);
      expect(declaring).toEqual([]);
      const loose = [...schemas]
        .filter(([, s]) =>
          JSON.stringify(s).includes('"additionalProperties":{}'),
        )
        .map(([n]) => n);
      expect(loose).toEqual([]);
    });
  }

  // With no `$schema`, MCP reads a schema as 2020-12, so that is the dialect each one must compile in.
  test("every published schema compiles as JSON Schema 2020-12", async () => {
    const validator = new CfWorkerJsonSchemaValidator({ draft: "2020-12" });
    const failing: string[] = [];
    for (const [name, schema] of await listedSchemas("SUPER_ADMIN")) {
      try {
        validator.getValidator(schema as never)({});
      } catch {
        failing.push(name);
      }
    }
    expect(failing).toEqual([]);
  });
});

describe("compactToolSchema", () => {
  test("drops the draft-07 dialect from the root", () => {
    const out = compactToolSchema(asSdkEmits(z.object({ a: z.string() })));
    expect(out).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  test("drops an empty additionalProperties at every schema position, and keeps a closed or typed one", () => {
    const raw = asSdkEmits(
      z.object({
        loose: z.looseObject({ x: z.number() }),
        list: z.array(z.looseObject({ y: z.string() })),
        either: z.union([z.looseObject({ u: z.string() }), z.number()]),
        closed: z.strictObject({ c: z.string() }),
        typed: z.record(z.string(), z.number()),
      }),
    );
    const out = JSON.stringify(compactToolSchema(raw));
    expect(out.includes('"additionalProperties":{}')).toBe(false);
    expect(out).toContain('"additionalProperties":false');
    expect(out).toContain('"additionalProperties":{"type":"number"}');
  });

  test("keeps a PROPERTY named additionalProperties and leaves data values alone", () => {
    const raw = {
      $schema: DRAFT_07,
      type: "object",
      properties: { additionalProperties: {}, $schema: { type: "string" } },
      default: { additionalProperties: {} },
      enum: [{ additionalProperties: {} }],
    };
    expect(compactToolSchema(raw)).toEqual({
      type: "object",
      properties: { additionalProperties: {}, $schema: { type: "string" } },
      default: { additionalProperties: {} },
      enum: [{ additionalProperties: {} }],
    });
  });

  // Each of these reads differently under 2020-12, the dialect MCP assumes once `$schema` is gone.
  test("keeps the dialect when the schema uses a keyword whose meaning changes in 2020-12", () => {
    // One keyword per case, nested one property deep, so each is detected on its own.
    const nested = (sub: Record<string, unknown>) => ({
      $schema: DRAFT_07,
      type: "object",
      properties: { a: sub },
    });
    const cases: Record<string, Record<string, unknown>> = {
      "zod tuple": asSdkEmits(
        z.object({ pair: z.tuple([z.string(), z.number()]) }),
      ),
      "items as an array": nested({
        type: "array",
        items: [{ type: "string" }],
      }),
      additionalItems: nested({ type: "array", additionalItems: false }),
      $ref: nested({ $ref: "#/$defs/x", description: "d" }),
      definitions: nested({ definitions: { x: { type: "string" } } }),
      dependencies: nested({ type: "object", dependencies: { b: ["c"] } }),
    };
    for (const [label, raw] of Object.entries(cases)) {
      expect([label, compactToolSchema(raw).$schema]).toEqual([
        label,
        DRAFT_07,
      ]);
    }
  });

  test("a dialect it does not know stays declared", () => {
    const raw = {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
    };
    expect(compactToolSchema(raw)).toEqual(raw);
  });

  // The equivalence that makes the trim safe, judged by the validators MCP clients use: the original
  // under draft-07 (Ajv) and the compacted one under 2020-12, the default once `$schema` is gone.
  test("the compacted schema accepts and refuses exactly what the original did", () => {
    const shape = z.object({
      name: z.string().min(1),
      count: z.number().int().min(0).optional(),
      block: z.looseObject({ mode: z.enum(["a", "b"]) }).optional(),
      rows: z.array(z.looseObject({ id: z.string() })).optional(),
      closed: z.strictObject({ k: z.boolean() }).optional(),
      bag: z.record(z.string(), z.unknown()).optional(),
    });
    const raw = asSdkEmits(shape);
    const compact = compactToolSchema(raw);
    const before = new AjvJsonSchemaValidator().getValidator(raw as never);
    const after = new CfWorkerJsonSchemaValidator({
      draft: "2020-12",
    }).getValidator(compact as never);
    const inputs: unknown[] = [
      { name: "x" },
      { name: "" },
      {},
      { name: "x", extra: 1 },
      { name: "x", count: -1 },
      { name: "x", count: 1.5 },
      { name: "x", block: { mode: "a", unknown_key: true } },
      { name: "x", block: { mode: "c" } },
      { name: "x", rows: [{ id: "1", more: [1, 2] }] },
      { name: "x", rows: [{ more: 1 }] },
      { name: "x", closed: { k: true } },
      { name: "x", closed: { k: true, extra: 1 } },
      { name: "x", bag: { anything: { nested: null } } },
      "not an object",
    ];
    const verdicts = inputs.map((input) => [
      JSON.stringify(input),
      before(input).valid,
      after(input).valid,
    ]);
    for (const [input, b, a] of verdicts) {
      expect([input, a]).toEqual([input, b]);
    }
    expect(verdicts.some(([, b]) => b === false)).toBe(true);
    expect(verdicts.some(([, b]) => b === true)).toBe(true);
  });
});
