import { describe, expect, test } from "bun:test";
import { DEFAULT_HTTP_TOOL_TIMEOUT_MS } from "@/graph/tools/http";
import {
  CALL_HTTP_TOOL_TIMEOUT_MS,
  elevenLabsToolDefs,
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

  test("every property gets a description and nullable types collapse", () => {
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
        a: { type: "string", description: "a" },
        b: { type: "integer", description: "bê" },
        c: {
          type: "array",
          description: "c",
          items: { type: "string", description: "c (item)" },
        },
      },
      required: ["a"],
    });
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
