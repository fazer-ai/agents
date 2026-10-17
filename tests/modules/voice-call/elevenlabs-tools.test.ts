import { describe, expect, test } from "bun:test";
import { DEFAULT_HTTP_TOOL_TIMEOUT_MS } from "@/graph/tools/http";
import {
  CALL_HTTP_TOOL_TIMEOUT_MS,
  elevenLabsToolDefs,
  fromElevenLabsArgs,
  syncElevenLabsTools,
  VOICE_TOOL_TIMEOUT_MS,
} from "@/modules/voice-call/providers/elevenlabs-tools";
import type { VoiceTool } from "@/modules/voice-call/providers/types";

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
