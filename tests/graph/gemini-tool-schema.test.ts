import { afterEach, describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { z } from "zod";
import { type GeminiFunctionTool, toGeminiTools } from "@/graph/gemini-tools";
import { createChatModel } from "@/graph/models";

// Gemini rejected EVERY turn of an agent whose tools carry a numeric bound or a free-form object
// parameter (issue #64): `parameters` is parsed as the OpenAPI 3.03 subset, whose field set is
// closed, and an unknown field kills the whole request before the model is reached. The fix declares
// tools with `parametersJsonSchema` instead, which takes a full JSON Schema.
//
// NOTE: the allowlist below is transcribed from the API's own discovery document
// (https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta, .schemas.Schema
// .properties) and is DELIBERATELY not imported from src — a test that reuses the implementation's
// idea of what the API accepts cannot catch that idea being wrong.
const OPENAPI_SUBSET_FIELDS = new Set([
  "anyOf",
  "default",
  "description",
  "enum",
  "example",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "nullable",
  "pattern",
  "properties",
  "propertyOrdering",
  "required",
  "title",
  "type",
]);

interface GeminiReject {
  message: string;
}

// Walks a `parameters` schema the way the API's proto3 parser does: the first field outside the
// subset aborts the request. Returns the rejection, or null when the schema is acceptable.
function rejectOpenApiSubset(node: unknown, path: string): GeminiReject | null {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) {
      const bad = rejectOpenApiSubset(v, `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node)) {
    if (!OPENAPI_SUBSET_FIELDS.has(key)) {
      return {
        message: `Invalid JSON payload received. Unknown name "${key}" at '${path}': Cannot find field.`,
      };
    }
    // `Schema.items` is a single Schema in the proto, so the draft-07 tuple form is a type error
    // rather than an unknown field.
    if (key === "items" && Array.isArray(value)) {
      return {
        message: `Invalid value at '${path}.items' (TYPE_MESSAGE), ${JSON.stringify(value)}`,
      };
    }
    if (key === "properties" && value && typeof value === "object") {
      for (const [prop, sub] of Object.entries(value)) {
        const bad = rejectOpenApiSubset(sub, `${path}.properties[${prop}]`);
        if (bad) return bad;
      }
      continue;
    }
    const bad = rejectOpenApiSubset(value, `${path}.${key}`);
    if (bad) return bad;
  }
  return null;
}

// The JSON Schema path accepts what the subset does not ($defs/$ref, const, exclusiveMinimum,
// additionalProperties, propertyNames, uniqueItems, multipleOf, oneOf/allOf, a `type` array and a
// non-string `enum` were all measured passing against the live API). The one construct it still
// rejects is a draft-07 tuple, because Gemini implements 2020-12, where `items` must be a schema.
function rejectJsonSchema(node: unknown, path: string): GeminiReject | null {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) {
      const bad = rejectJsonSchema(v, `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node)) {
    if (key === "items" && Array.isArray(value)) {
      return {
        message: `Invalid value at 'tools[0].function_declarations[0].parameters_json_schema': schema at ${path}.items must be a boolean or an object`,
      };
    }
    if (key === "properties" && value && typeof value === "object") {
      for (const [prop, sub] of Object.entries(value)) {
        const bad = rejectJsonSchema(sub, `${path}.properties.${prop}`);
        if (bad) return bad;
      }
      continue;
    }
    const bad = rejectJsonSchema(value, `${path}.${key}`);
    if (bad) return bad;
  }
  return null;
}

interface FakeGemini {
  requests: unknown[];
  restore: () => void;
}

// Stands in for generativelanguage: validates the declared tools exactly as the API does, so a
// payload that would 400 in production 400s here too.
function fakeGemini(): FakeGemini {
  const requests: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      tools?: { functionDeclarations?: Record<string, unknown>[] }[];
    };
    requests.push(body);
    // Gemini refuses a request carrying more than one tool entry unless they are all search tools,
    // so a regression that emits one entry per tool has to fail here, not just in a unit assertion.
    const entries = (body.tools ?? []).filter(
      (t) => (t.functionDeclarations ?? []).length > 0,
    );
    if (entries.length > 1) {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message:
              "Multiple tools are supported only when they are all search tools",
            status: "INVALID_ARGUMENT",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const declarations = entries.flatMap((t) => t.functionDeclarations ?? []);
    for (const [i, decl] of declarations.entries()) {
      const at = `tools[0].function_declarations[${i}].parameters`;
      const bad = decl.parameters
        ? rejectOpenApiSubset(decl.parameters, at)
        : decl.parametersJsonSchema
          ? rejectJsonSchema(decl.parametersJsonSchema, at)
          : null;
      if (bad) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: bad.message,
              status: "INVALID_ARGUMENT",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "ok" }], role: "model" },
            finishReason: "STOP",
            index: 0,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// The three shapes that reach bindTools in production: a native tool with a numeric bound, an HTTP
// tool with a free-form object parameter (src/graph/tools/http.ts builds one per object field), and
// an MCP tool carrying a third-party JSON Schema.
const getCurrentTime = tool(async () => "10:00", {
  name: "get_current_time",
  description: "Current time in a timezone",
  schema: z.object({
    timezone: z.string().optional(),
    roundToMinutes: z.number().int().positive().optional(),
  }),
});

const callApi = tool(async () => "ok", {
  name: "call_api",
  description: "Call an API",
  schema: z.object({ body: z.record(z.string(), z.unknown()) }),
});

const resolveConversation = tool(async () => "ok", {
  name: "resolve_conversation",
  description: "Resolve the conversation",
  schema: z.object({}),
});

const mcpTool = tool(async () => "ok", {
  name: "mcp__crm__lookup",
  description: "Look a customer up",
  schema: {
    type: "object",
    $defs: {
      Addr: { type: "object", properties: { city: { type: "string" } } },
    },
    properties: {
      addr: { $ref: "#/$defs/Addr" },
      kind: { const: "person" },
      tags: { type: "array", items: { type: "string" }, uniqueItems: true },
    },
    additionalProperties: false,
  },
});

const googleModel = () =>
  createChatModel({
    provider: "google",
    model: "gemini-3.5-flash",
    apiKey: "test",
    temperature: 0.7,
  });

let gemini: FakeGemini | null = null;
afterEach(() => {
  gemini?.restore();
  gemini = null;
});

// The whole suite leans on the fake rejecting what the real API rejects. If a branch of that
// validator silently stopped firing, every positive test below would still pass and the regression
// guard would be decorative, so the validator is driven into each of its rejections directly.
describe("the fake API rejects what generativelanguage rejects", () => {
  const post = (tools: unknown) =>
    fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
      { method: "POST", body: JSON.stringify({ tools }) },
    );

  test("a field outside the OpenAPI subset", async () => {
    gemini = fakeGemini();
    const res = await post([
      {
        functionDeclarations: [
          {
            name: "t",
            parameters: {
              type: "object",
              properties: { n: { type: "integer", exclusiveMinimum: 0 } },
            },
          },
        ],
      },
    ]);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain(
      'Unknown name "exclusiveMinimum"',
    );
  });

  test("a draft-07 tuple declared as JSON Schema", async () => {
    gemini = fakeGemini();
    const res = await post([
      {
        functionDeclarations: [
          {
            name: "t",
            parametersJsonSchema: {
              type: "object",
              properties: {
                pair: { type: "array", items: [{ type: "string" }] },
              },
            },
          },
        ],
      },
    ]);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain(
      "must be a boolean or an object",
    );
  });

  test("more than one tool entry", async () => {
    gemini = fakeGemini();
    const res = await post([
      { functionDeclarations: [{ name: "a" }] },
      { functionDeclarations: [{ name: "b" }] },
    ]);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("Multiple tools");
  });
});

describe("Gemini tool declarations", () => {
  test("a turn with the production toolset is not rejected", async () => {
    gemini = fakeGemini();
    const reply = await googleModel()
      .bindTools?.([getCurrentTime, callApi, resolveConversation, mcpTool])
      .invoke([{ role: "user", content: "que horas são?" }]);
    expect(reply?.content).toBe("ok");
  });

  test("declarations travel as JSON Schema, never as the OpenAPI subset", async () => {
    gemini = fakeGemini();
    await googleModel()
      .bindTools?.([getCurrentTime])
      .invoke([{ role: "user", content: "oi" }]);
    const [sent] = gemini.requests as {
      tools: { functionDeclarations: Record<string, unknown>[] }[];
    }[];
    const decl = sent?.tools[0]?.functionDeclarations[0];
    expect(decl?.parameters).toBeUndefined();
    expect(decl?.parametersJsonSchema).toBeDefined();
  });

  test("the schema reaches the model exactly as authored", () => {
    const [entry] = toGeminiTools([getCurrentTime]) as {
      functionDeclarations: { parametersJsonSchema: unknown }[];
    }[];
    // The bound `roundToMinutes` survives instead of being approximated: `exclusiveMinimum` is what
    // the OpenAPI subset has no way to express, and losing it would let the model pass 0.
    expect(entry?.functionDeclarations[0]?.parametersJsonSchema).toEqual(
      toJsonSchema(getCurrentTime.schema) as object,
    );
  });

  test("every tool lands in ONE declarations entry", () => {
    const out = toGeminiTools([getCurrentTime, callApi, mcpTool]) as {
      functionDeclarations: { name: string }[];
    }[];
    expect(out).toHaveLength(1);
    expect(out[0]?.functionDeclarations.map((d) => d.name)).toEqual([
      "get_current_time",
      "call_api",
      "mcp__crm__lookup",
    ]);
  });

  // Regression: the upstream adapter folds ITS conversions into a declaration entry the caller
  // already passed, exactly so the request never carries two. Ours arrive pre-converted, which
  // leaves that accumulator empty, so a mixed bindTools call would ship both entries.
  test("a declarations entry from the caller absorbs ours instead of sitting beside it", () => {
    const preConverted = {
      functionDeclarations: [{ name: "already_there", description: "Given" }],
    };
    const out = toGeminiTools([
      preConverted,
      getCurrentTime,
    ]) as GeminiFunctionTool[];
    expect(out).toHaveLength(1);
    expect(out[0]?.functionDeclarations.map((d) => d.name)).toEqual([
      "already_there",
      "get_current_time",
    ]);
    // The caller's object is left alone: the fold builds a new entry.
    expect(preConverted.functionDeclarations).toHaveLength(1);
  });

  test("a mixed bindTools call is not rejected as multiple tools", async () => {
    gemini = fakeGemini();
    const reply = await googleModel()
      .bindTools?.([
        { functionDeclarations: [{ name: "already_there" }] },
        getCurrentTime,
      ])
      .invoke([{ role: "user", content: "que horas são?" }]);
    expect(reply?.content).toBe("ok");
    const [sent] = gemini.requests as { tools: unknown[] }[];
    expect(sent?.tools).toHaveLength(1);
  });

  test("a parameterless tool declares no parameters at all", () => {
    const [entry] = toGeminiTools([
      resolveConversation,
    ]) as GeminiFunctionTool[];
    const decl = entry?.functionDeclarations[0];
    expect(decl?.name).toBe("resolve_conversation");
    expect(decl).not.toHaveProperty("parametersJsonSchema");
    expect(decl).not.toHaveProperty("parameters");
  });

  test("a draft-07 tuple is translated instead of rejected", async () => {
    const tupleTool = tool(async () => "ok", {
      name: "mcp__legacy__pair",
      description: "Takes a pair",
      schema: {
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      },
    });
    gemini = fakeGemini();
    const reply = await googleModel()
      .bindTools?.([tupleTool])
      .invoke([{ role: "user", content: "oi" }]);
    expect(reply?.content).toBe("ok");
    const [entry] = toGeminiTools([tupleTool]) as {
      functionDeclarations: {
        parametersJsonSchema: { properties: { pair: Record<string, unknown> } };
      }[];
    }[];
    const pair =
      entry?.functionDeclarations[0]?.parametersJsonSchema.properties.pair;
    expect(pair?.prefixItems).toEqual([{ type: "string" }, { type: "number" }]);
    expect(pair).not.toHaveProperty("items");
  });

  // `additionalItems` is the other half of the same draft-07 tuple. Leaving it behind would widen
  // the contract, because `false` means "nothing past the tuple" and 2020-12 spells that `items:
  // false` — measured accepted by the live API.
  test.each([
    ["a closed tuple", false, false],
    ["an open tuple with a type", { type: "string" }, { type: "string" }],
  ])(
    "%s keeps its bound on the extras",
    (_label, additionalItems, expected) => {
      const legacy = tool(async () => "ok", {
        name: "mcp__legacy__bounded",
        description: "d",
        schema: {
          type: "object",
          properties: {
            pair: {
              type: "array",
              items: [{ type: "string" }, { type: "number" }],
              additionalItems,
            },
          },
        } as never,
      });
      const [entry] = toGeminiTools([legacy]) as GeminiFunctionTool[];
      const declared = entry?.functionDeclarations[0]?.parametersJsonSchema as {
        properties: { pair: Record<string, unknown> };
      };
      const pair = declared.properties.pair;
      expect(pair.prefixItems).toEqual([
        { type: "string" },
        { type: "number" },
      ]);
      expect(pair.items).toEqual(expected);
      expect(pair).not.toHaveProperty("additionalItems");
    },
  );

  test("additionalItems outside a tuple is dropped, as both drafts ignore it", () => {
    const stray = tool(async () => "ok", {
      name: "mcp__legacy__stray",
      description: "d",
      schema: {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: { type: "string" },
            additionalItems: { type: "number" },
          },
        },
      } as never,
    });
    const [entry] = toGeminiTools([stray]) as GeminiFunctionTool[];
    const declared = entry?.functionDeclarations[0]?.parametersJsonSchema as {
      properties: { list: Record<string, unknown> };
    };
    const list = declared.properties.list;
    expect(list.items).toEqual({ type: "string" });
    expect(list).not.toHaveProperty("additionalItems");
  });

  // Inside `properties` the keys are parameter NAMES chosen by whoever wrote the tool, so the
  // draft-07 translation must not run there: it would delete a parameter the schema still requires.
  test("a parameter NAMED additionalItems is not mistaken for the keyword", () => {
    const collides = tool(async () => "ok", {
      name: "mcp__legacy__collides",
      description: "d",
      schema: {
        type: "object",
        properties: { additionalItems: { type: "string" } },
        required: ["additionalItems"],
      } as never,
    });
    const [entry] = toGeminiTools([collides]) as GeminiFunctionTool[];
    const declared = entry?.functionDeclarations[0]?.parametersJsonSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(declared.properties)).toEqual(["additionalItems"]);
    expect(declared.required).toEqual(["additionalItems"]);
  });

  // `enum`/`const`/`default`/`examples` hold instance DATA. Rewriting an `items` array inside one of
  // them changes which values the model is allowed to send, which is a different contract, not a
  // translation.
  test("instance data is never rewritten as if it were a schema", () => {
    const dataTool = tool(async () => "ok", {
      name: "mcp__legacy__data",
      description: "d",
      schema: {
        type: "object",
        properties: {
          shape: {
            type: "object",
            enum: [{ items: ["a", "b"], additionalItems: false }],
            default: { items: ["a", "b"], additionalItems: false },
          },
        },
      } as never,
    });
    const [entry] = toGeminiTools([dataTool]) as GeminiFunctionTool[];
    const declared = entry?.functionDeclarations[0]?.parametersJsonSchema as {
      properties: { shape: { enum: unknown[]; default: unknown } };
    };
    const preserved = { items: ["a", "b"], additionalItems: false };
    expect(declared.properties.shape.enum).toEqual([preserved]);
    expect(declared.properties.shape.default).toEqual(preserved);
  });

  // Built through JSON.parse on purpose: an object literal would set the prototype instead of
  // creating the key, which is exactly the trap on the output side.
  test("a parameter named __proto__ still reaches the wire", () => {
    const proto = tool(async () => "ok", {
      name: "mcp__legacy__proto",
      description: "d",
      schema: JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
      ),
    });
    const [entry] = toGeminiTools([proto]) as GeminiFunctionTool[];
    const declared = entry?.functionDeclarations[0]?.parametersJsonSchema as {
      properties: Record<string, unknown>;
    };
    // Own key, and present in the serialized body — NOT `toContain("__proto__")` on the whole
    // schema, which `required: ["__proto__"]` satisfies whether or not the parameter survived.
    expect(Object.keys(declared.properties)).toEqual(["__proto__"]);
    expect(JSON.stringify(declared.properties)).toContain('"__proto__"');
  });

  test("an explicit prefixItems is not overwritten by the items rename", () => {
    const both = tool(async () => "ok", {
      name: "mcp__legacy__both",
      description: "d",
      schema: {
        type: "object",
        properties: {
          pair: {
            type: "array",
            prefixItems: [{ type: "boolean" }],
            items: [{ type: "string" }],
          },
        },
      },
    });
    const [entry] = toGeminiTools([both]) as {
      functionDeclarations: {
        parametersJsonSchema: { properties: { pair: Record<string, unknown> } };
      }[];
    }[];
    const pair =
      entry?.functionDeclarations[0]?.parametersJsonSchema.properties.pair;
    expect(pair?.prefixItems).toEqual([{ type: "boolean" }]);
  });

  // An MCP server can describe its arguments without listing a single property. Treating "no
  // properties" as "no parameters" would declare those tools parameterless, and the model would
  // then call them with nothing.
  test.each([
    [
      "an additionalProperties map",
      { type: "object", additionalProperties: { type: "string" } },
    ],
    [
      "a root $ref",
      { $ref: "#/$defs/Input", $defs: { Input: { type: "object" } } },
    ],
    ["a union", { anyOf: [{ type: "object" }, { type: "string" }] }],
  ])(
    "a schema that describes arguments through %s is still declared",
    (_label, schema) => {
      const mcp = tool(async () => "ok", {
        name: "mcp__srv__thing",
        description: "d",
        schema: schema as never,
      });
      const [entry] = toGeminiTools([mcp]) as GeminiFunctionTool[];
      expect(entry?.functionDeclarations[0]?.parametersJsonSchema).toEqual(
        schema,
      );
    },
  );

  test("nesting past the depth cap travels untransformed instead of throwing", () => {
    // NOTE: pins the documented degradation. Past MAX_DEPTH the subtree is left exactly as it
    // arrived, which is what shipped before this module existed, rather than a stack overflow on a
    // hostile schema.
    let deep: Record<string, unknown> = {
      type: "array",
      items: [{ type: "string" }],
    };
    for (let i = 0; i < 70; i++) {
      deep = { type: "object", properties: { next: deep } };
    }
    const hostile = tool(async () => "ok", {
      name: "mcp__srv__deep",
      description: "d",
      schema: deep as never,
    });
    const [entry] = toGeminiTools([hostile]) as GeminiFunctionTool[];
    const declared = entry?.functionDeclarations[0]?.parametersJsonSchema as
      | Record<string, unknown>
      | undefined;
    let node = declared;
    for (let i = 0; i < 70; i++) {
      node = (node?.properties as { next?: Record<string, unknown> })?.next;
    }
    expect(node).toHaveProperty("items");
    expect(node).not.toHaveProperty("prefixItems");
  });

  test("what is not a LangChain tool is passed through untouched", () => {
    const search = { googleSearchRetrieval: {} };
    const out = toGeminiTools([search, getCurrentTime]);
    expect(out[0]).toBe(search);
    expect(out[1]).toHaveProperty("functionDeclarations");
  });

  test("the shared schema is not mutated, so other providers keep theirs", () => {
    // NOTE: toJsonSchema memoizes per schema and hands back the SAME object every time, so an
    // in-place edit here would corrupt what ChatOpenAI/ChatAnthropic declare for the rest of the
    // process — a cross-provider break that no Gemini test would ever show.
    const before = structuredClone(
      toJsonSchema(getCurrentTime.schema) as object,
    );
    toGeminiTools([getCurrentTime]);
    expect(toJsonSchema(getCurrentTime.schema)).toEqual(before);
  });

  test("only the Google provider is patched", () => {
    const openai = createChatModel({
      provider: "openai",
      model: "gpt-5.4-mini",
      apiKey: "test",
    });
    expect(Object.hasOwn(openai, "bindTools")).toBe(false);
  });
});
