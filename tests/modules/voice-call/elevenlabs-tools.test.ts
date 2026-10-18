import { describe, expect, test } from "bun:test";
import { DEFAULT_HTTP_TOOL_TIMEOUT_MS } from "@/graph/tools/http";
import {
  CALL_HTTP_TOOL_TIMEOUT_MS,
  elevenLabsSchema,
  elevenLabsToolDefs,
  fromElevenLabsArgs,
  syncElevenLabsTools,
  VOICE_TOOL_TIMEOUT_MS,
} from "@/modules/voice-call/providers/elevenlabs-tools";
import type { VoiceTool } from "@/modules/voice-call/providers/types";

type Schema = Record<string, unknown>;

const tool = (
  name: string,
  parameters: Record<string, unknown>,
): VoiceTool => ({
  name,
  description: `faz ${name}`,
  parameters,
  invoke: async () => "",
});

describe("elevenlabs tool declarations", () => {
  test("an HTTP tool settles before this side answers the engine, and the engine waits longer still", () => {
    const [def] = elevenLabsToolDefs([tool("x", { type: "object" })]);
    const engineMs = (def?.response_timeout_secs ?? 0) * 1000;
    expect(CALL_HTTP_TOOL_TIMEOUT_MS).toBeLessThanOrEqual(
      DEFAULT_HTTP_TOOL_TIMEOUT_MS,
    );
    expect(VOICE_TOOL_TIMEOUT_MS).toBeGreaterThan(CALL_HTTP_TOOL_TIMEOUT_MS);
    expect(engineMs).toBeGreaterThan(VOICE_TOOL_TIMEOUT_MS);
    expect(engineMs).toBeLessThanOrEqual(120_000);
  });

  test("a union of types travels as JSON text naming its types, and comes back as the value", () => {
    const schema = {
      type: "object",
      properties: {
        limite: { type: ["number", "boolean"], description: "o limite" },
        filtro: {
          anyOf: [
            { type: "null" },
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        nome: { type: "string" },
      },
    };
    const [def] = elevenLabsToolDefs([tool("buscar", schema)]);
    if (!def) throw new Error("no tool definition");
    const props = (def.parameters as { properties: Record<string, unknown> })
      .properties;
    expect(props.limite).toEqual({
      type: "string",
      description: "o limite (a JSON value: number or boolean)",
    });
    expect(props.filtro).toEqual({
      type: "string",
      description: "filtro (a JSON value: string or array or null)",
    });
    expect(
      fromElevenLabsArgs(schema, {
        limite: "5",
        filtro: '["a","b"]',
        nome: "42",
      }),
    ).toEqual({ limite: 5, filtro: ["a", "b"], nome: "42" });
    // Null, which a nullable union allows, is sent as JSON too.
    expect(fromElevenLabsArgs(schema, { filtro: "null" })).toEqual({
      filtro: null,
    });
    // Text that is not one of its types is left as it came, for the tool to refuse.
    expect(fromElevenLabsArgs(schema, { limite: "muito" })).toEqual({
      limite: "muito",
    });
    // Nor is JSON of another type: an object where a number or a boolean goes.
    expect(fromElevenLabsArgs(schema, { limite: '{"a":1}' })).toEqual({
      limite: '{"a":1}',
    });
  });

  // An MCP tool may leave a value unconstrained (`value: {}`): declared as a plain string, a number or
  // an object would reach the tool as its text. It travels as JSON text instead, as a union does.
  test("an unconstrained value travels as JSON text, and comes back as the value it holds", () => {
    const schema = {
      type: "object",
      properties: { key: { type: "string" }, value: {} },
      required: ["key", "value"],
    };
    const declared = elevenLabsSchema(schema, "set_field") as {
      properties: Record<string, { type: string; description: string }>;
    };
    expect(declared.properties.value).toEqual({
      type: "string",
      description: "value (a JSON value: any type)",
    });
    expect(declared.properties.key?.type).toBe("string");
    const read = (value: string) =>
      (fromElevenLabsArgs(schema, { key: "k", value }) as { value: unknown })
        .value;
    expect([
      read("42"),
      read("true"),
      read('{"a":1}'),
      read("[1,2]"),
      read("null"),
      read('"texto"'),
      // Text that is not JSON is what the model meant to send: it stays text.
      read("texto"),
    ]).toEqual([42, true, { a: 1 }, [1, 2], null, "texto", "texto"]);
    // A value an enum or a const holds keeps its declaration; `items` alone does not hold a type.
    const kept = (value: Schema) =>
      elevenLabsSchema({ type: "object", properties: { value } }, "t") as {
        properties: { value: Schema };
      };
    expect(kept({ enum: ["a", "b"] }).properties.value).toEqual({
      type: "string",
      description: "value",
      enum: ["a", "b"],
    });
    // A constant is the one value the tool takes, so it is declared as an enum of one.
    expect([
      kept({ const: "person" }).properties.value,
      kept({ const: 2 }).properties.value,
      kept({ const: true }).properties.value,
      kept({ type: "string", const: "x" }).properties.value,
    ]).toEqual([
      { type: "string", description: "value", enum: ["person"] },
      { type: "integer", description: "value", enum: [2] },
      { type: "boolean", description: "value", enum: [true] },
      { type: "string", description: "value", enum: ["x"] },
    ]);
    expect(kept({ items: { type: "number" } }).properties.value).toEqual({
      type: "string",
      description: "value (a JSON value: any type)",
    });
  });

  // An enum with no type is declared with the one type its values share; values of different types,
  // or null among them, cannot be listed as one, so they travel as JSON and only the enum's own values
  // come back parsed.
  test("an untyped enum keeps the type of its values, or travels as JSON when they differ", () => {
    const declared = (value: Schema) =>
      (
        elevenLabsSchema({ type: "object", properties: { value } }, "t") as {
          properties: { value: Schema };
        }
      ).properties.value;
    expect([
      declared({ enum: [1, 2] }),
      declared({ enum: [1, 2.5] }),
      declared({ enum: [true, false] }),
      declared({ enum: [1, "a"] }),
      declared({ enum: ["a", null] }),
    ]).toEqual([
      { type: "integer", description: "value", enum: [1, 2] },
      { type: "number", description: "value", enum: [1, 2.5] },
      { type: "boolean", description: "value", enum: [true, false] },
      {
        type: "string",
        description: 'value (a JSON value: value (one of 1, "a"))',
      },
      {
        type: "string",
        description: 'value (a JSON value: value (one of "a", null))',
      },
    ]);
    const read = (value: string) =>
      (
        fromElevenLabsArgs(
          { type: "object", properties: { value: { enum: [1, "a", null] } } },
          { value },
        ) as { value: unknown }
      ).value;
    expect([
      read("1"),
      read('"a"'),
      read("null"),
      read("2"),
      read("b"),
    ]).toEqual([1, "a", null, "2", "b"]);
  });

  // A dictionary input (`z.record`, an HTTP tool's object field) has keys the caller chooses: declared
  // as an empty object the engine would send it empty, so it travels as JSON and comes back an object.
  test("a dictionary travels as JSON text and comes back as the object it holds", () => {
    const schema = {
      type: "object",
      properties: {
        meta: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: {},
        },
        flags: { type: "object", additionalProperties: true },
        fixed: { type: "object", properties: {}, additionalProperties: false },
        // Fields of its own keep the shape, extra keys or not; and an object that says nothing about
        // extra keys is not a dictionary (a tool with no arguments is that).
        named: {
          type: "object",
          properties: { id: { type: "string" } },
          additionalProperties: { type: "string" },
        },
        empty: { type: "object" },
      },
      required: ["meta"],
      additionalProperties: false,
    };
    const declared = (
      elevenLabsSchema(schema, "t") as { properties: Record<string, Schema> }
    ).properties;
    expect([
      declared.meta,
      declared.flags,
      declared.fixed,
      declared.named,
      declared.empty,
    ]).toEqual([
      { type: "string", description: "meta (a JSON value: object)" },
      { type: "string", description: "flags (a JSON value: object)" },
      { type: "object", description: "fixed", properties: {}, required: [] },
      {
        type: "object",
        description: "named",
        properties: { id: { type: "string", description: "id" } },
        required: [],
      },
      { type: "object", description: "empty", properties: {}, required: [] },
    ]);
    expect(
      fromElevenLabsArgs(schema, {
        meta: '{"origem":"site","lote":3}',
        flags: "[1]",
      }),
    ).toEqual({ meta: { origem: "site", lote: 3 }, flags: "[1]" });
  });

  test("every property gets a description, and a nullable scalar may still be null", () => {
    const defs = elevenLabsToolDefs([
      tool("x", {
        type: "object",
        additionalProperties: false,
        properties: {
          a: { type: ["string", "null"] },
          b: {
            anyOf: [{ type: "null" }, { type: "integer" }],
            description: "bê",
          },
          c: { type: "array", items: { type: "string" } },
        },
        required: ["a"],
      }),
    ]);
    expect(defs).toHaveLength(1);
    expect(defs[0]?.type).toBe("client");
    expect(defs[0]?.parameters).toEqual({
      type: "object",
      properties: {
        a: { type: "string", description: "a (a JSON value: string or null)" },
        b: {
          type: "string",
          description: "bê (a JSON value: integer or null)",
        },
        c: {
          type: "array",
          description: "c",
          items: { type: "string", description: "c (item)" },
        },
      },
      required: ["a"],
    });
    const original = {
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        b: { anyOf: [{ type: "null" }, { type: "integer" }] },
      },
    };
    // Null clears where leaving the field out keeps it, so it comes back as null; text stays text,
    // and a number the integer branch takes comes back as one.
    expect(fromElevenLabsArgs(original, { a: "null", b: "null" })).toEqual({
      a: null,
      b: null,
    });
    expect(fromElevenLabsArgs(original, { a: "Maria", b: "7" })).toEqual({
      a: "Maria",
      b: 7,
    });
    expect(fromElevenLabsArgs(original, { a: "123" })).toEqual({ a: "123" });
  });

  test("the same set is declared once; a changed set is declared again", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const opts = { apiKey: "k", agentId: "agent-sync-test", fetchImpl };
    const tools = [tool("x", { type: "object", properties: {} })];
    const declared = await syncElevenLabsTools(opts, tools);
    expect(declared).toBeString();
    expect(await syncElevenLabsTools({ ...opts, declared }, tools)).toBeNull();
    expect(calls).toHaveLength(1);
    await syncElevenLabsTools({ ...opts, declared }, [
      ...tools,
      tool("y", { type: "object", properties: {} }),
    ]);
    expect(calls).toHaveLength(2);
    const declaredTools = JSON.parse(calls[0] ?? "{}").conversation_config.agent
      .prompt.tools as { type: string; name: string }[];
    // end_call travels in the same list: beside it, under built_in_tools, the platform drops it.
    expect(declaredTools.map((t) => [t.type, t.name])).toEqual([
      ["client", "x"],
      ["system", "end_call"],
    ]);
  });

  test("a declaration whose answer is lost leaves the agent's tools unknown, so the next one is sent", async () => {
    const sent: string[] = [];
    let loseAnswer = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(String(init.body));
      // Applied on ElevenLabs, but the answer never arrives.
      if (loseAnswer) throw new Error("socket hang up");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    // What the hold keeps, as the row would.
    let recorded: string | null = null;
    const sync = async (set: Parameters<typeof syncElevenLabsTools>[1]) => {
      const declared = await syncElevenLabsTools(
        {
          apiKey: "k",
          agentId: "agent-lost-answer",
          fetchImpl,
          declared: recorded,
          onDeclaring: async () => {
            recorded = null;
          },
        },
        set,
      );
      if (declared) recorded = declared;
    };
    const a = [tool("a", { type: "object", properties: {} })];
    const b = [tool("b", { type: "object", properties: {} })];
    await sync(a);
    loseAnswer = true;
    await expect(sync(b)).rejects.toThrow("socket hang up");
    loseAnswer = false;
    await sync(a);
    expect(sent).toHaveLength(3);
  });

  test("a refused declaration fails the call's opening and answers nothing to remember", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response("nope", { status: n === 1 ? 422 : 200 });
    }) as unknown as typeof fetch;
    const opts = { apiKey: "k", agentId: "agent-refused", fetchImpl };
    await expect(syncElevenLabsTools(opts, [])).rejects.toThrow("422");
    await syncElevenLabsTools(opts, []);
    expect(n).toBe(2);
  });
});
