import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { parseModelConfig } from "@/graph/model-config";
import { createChatModel } from "@/graph/models";
import { markAnthropicBody } from "@/graph/prompt-cache";

// What actually leaves for the provider when an agent's model config asks for prompt caching. The
// provider is a local server that records each request body, so every assertion reads the bytes the
// API would have received, not the adapter's intermediate objects.

const bodies: Array<Record<string, unknown>> = [];

const anthropicReply = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 2 },
};

const chatReply = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "x",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

// The suite's DOM preload replaces the global `Response` and applies same-origin to `fetch`
// (tests/dom-setup.ts), so the recorder answers with Bun's own Response and the CORS headers.
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};

// OpenAI-family models behind OpenRouter go over /responses (./openai-reasoning).
const responsesReply = {
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "x",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
};

let server: ReturnType<typeof Bun.serve>;
let prevBase: string | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS")
        return new BunResponse(null, { status: 204, headers: CORS });
      const body = (await req.json()) as Record<string, unknown>;
      bodies.push(body);
      const url = new URL(req.url);
      const reply = url.pathname.endsWith("/messages")
        ? anthropicReply
        : url.pathname.endsWith("/responses")
          ? responsesReply
          : chatReply;
      return new BunResponse(JSON.stringify(reply), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    },
  });
  // NOTE: the anthropic provider takes no baseURL from the agent's config, and the SDK reads this
  // variable when none is given, which is how the request reaches the recorder instead of the API.
  prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = prevBase;
});

const lookup = tool(async () => "ok", {
  name: "consultar_evento",
  description: "Consulta um evento",
  schema: z.object({ nome: z.string() }),
});

const history = [
  new SystemMessage("Você é a atendente. ".repeat(40)),
  new HumanMessage("oi"),
  new AIMessage("Olá! Como posso ajudar?"),
  new HumanMessage("quero saber do show de sábado"),
];

async function send(
  modelConfig: Record<string, unknown>,
  messages: BaseMessage[] = history,
): Promise<Record<string, unknown>> {
  const before = bodies.length;
  const cfg = parseModelConfig(modelConfig);
  const model = createChatModel({ ...cfg, apiKey: "k", maxRetries: 0 });
  const bound = model.bindTools?.([lookup]) ?? model;
  await bound.invoke(messages);
  const body = bodies[before];
  if (!body) throw new Error("no request reached the recorder");
  return body;
}

function marks(body: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.cache_control) out.push(o.cache_control as Record<string, unknown>);
      for (const x of Object.values(o)) walk(x);
    }
  };
  walk(body);
  return out;
}

const last = <T>(xs: T[] | undefined): T | undefined => xs?.[xs.length - 1];

function lastBlock(msg: unknown): Record<string, unknown> | undefined {
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content)
    ? (last(content) as Record<string, unknown>)
    : undefined;
}

const anthropic = { provider: "anthropic", model: "claude-haiku-5-5" };

describe("anthropic: the prefix and the conversation are marked by default", () => {
  test("the last tool, the last system block and the last message carry a mark", async () => {
    const body = await send(anthropic);
    expect(
      (last(body.tools as unknown[]) as Record<string, unknown>).cache_control,
    ).toEqual({ type: "ephemeral" });
    expect(last(body.system as unknown[])).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
    expect(lastBlock(last(body.messages as unknown[]))?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(marks(body).length).toBeLessThanOrEqual(4);
  });

  test("off sends no mark anywhere", async () => {
    const body = await send({ ...anthropic, promptCache: "off" });
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  test("a 1h prefix TTL reaches every mark when the conversation TTL is not set", async () => {
    const body = await send({ ...anthropic, promptCacheTtl: "1h" });
    const all = marks(body);
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) expect(m).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("a 1h prefix with a 5m conversation marks each span with its own TTL", async () => {
    const body = await send({
      ...anthropic,
      promptCacheTtl: "1h",
      promptCacheConversationTtl: "5m",
    });
    expect(last(body.system as unknown[])).toMatchObject({
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    expect(lastBlock(last(body.messages as unknown[]))?.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  test("the prefix is byte-identical from one turn to the next, and the mark moves to the new end", async () => {
    const one = await send(anthropic);
    const two = await send(anthropic, [
      ...history,
      new AIMessage("Qual o nome do show?"),
      new HumanMessage("Rock na Praça"),
    ]);
    expect(JSON.stringify(two.tools)).toBe(JSON.stringify(one.tools));
    expect(JSON.stringify(two.system)).toBe(JSON.stringify(one.system));
    const strip = (m: unknown) =>
      JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v));
    const n = (one.messages as unknown[]).length;
    expect((two.messages as unknown[]).slice(0, n).map(strip)).toEqual(
      (one.messages as unknown[]).map(strip),
    );
    expect(
      lastBlock(last(two.messages as unknown[]))?.cache_control,
    ).toBeDefined();
  });
});

describe("anthropic: a tool round inside the turn", () => {
  test("the mark sits on the tool result that ends the request, and the count stays within 4", async () => {
    const body = await send(anthropic, [
      ...history,
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "tc_1", name: "consultar_evento", args: { nome: "Rock" } },
        ],
      }),
      new ToolMessage({ content: "sábado, 20h", tool_call_id: "tc_1" }),
    ]);
    const end = lastBlock(last(body.messages as unknown[]));
    expect(end?.type).toBe("tool_result");
    expect(end?.cache_control).toEqual({ type: "ephemeral" });
    expect(marks(body).length).toBeLessThanOrEqual(4);
  });
});

describe("blocks the API refuses a mark on", () => {
  test("an empty last text block is skipped for the block before it", () => {
    const body = markAnthropicBody(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "quero ingresso" },
              { type: "text", text: "  " },
            ],
          },
        ],
      },
      { prefixTtl: "5m", conversationTtl: "5m" },
    );
    const content = (
      body.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0]?.content;
    expect(content?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(content?.[1]).not.toHaveProperty("cache_control");
  });

  test("a thinking block is skipped for the block before it", () => {
    const body = markAnthropicBody(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Vou consultar." },
              { type: "thinking", thinking: "...", signature: "s" },
            ],
          },
        ],
      },
      { prefixTtl: "5m", conversationTtl: "5m" },
    );
    const content = (
      body.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0]?.content;
    expect(content?.[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(content?.[1]).not.toHaveProperty("cache_control");
  });
});

describe("a system prompt already in blocks", () => {
  test("its last block carries the prefix TTL, apart from the conversation's", () => {
    const body = markAnthropicBody(
      {
        system: [
          { type: "text", text: "regras" },
          { type: "text", text: "mais regras" },
        ],
        messages: [{ role: "user", content: "oi" }],
      },
      { prefixTtl: "1h", conversationTtl: "5m" },
    );
    const system = body.system as Array<Record<string, unknown>>;
    expect(system[0]).not.toHaveProperty("cache_control");
    expect(system[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const msg = (
      body.messages as Array<{ content: Array<Record<string, unknown>> }>
    )[0];
    expect(msg?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("openrouter: only a Claude model behind it is marked", () => {
  const base = () => `http://localhost:${server.port}`;

  test("anthropic/* gets marks on the system message and the last message", async () => {
    const body = await send({
      provider: "openrouter",
      model: "anthropic/claude-haiku-5.5",
      baseURL: base(),
    });
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(lastBlock(msgs[0])?.cache_control).toEqual({ type: "ephemeral" });
    expect(lastBlock(last(msgs))?.cache_control).toEqual({
      type: "ephemeral",
    });
    expect(marks(body).length).toBeLessThanOrEqual(4);
  });

  // Over chat completions, the same route a Claude model takes, so only the model decides.
  test("a Gemini model behind it is left alone too", async () => {
    const body = await send({
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      baseURL: base(),
    });
    expect(Array.isArray(body.messages)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  test("an OpenAI model behind it is left alone: it caches on its own", async () => {
    const body = await send({
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      baseURL: base(),
    });
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });
});

describe("the policy is refused where it would do nothing or break the request", () => {
  test("unknown values are refused, naming the field", () => {
    expect(() =>
      parseModelConfig({ ...anthropic, promptCache: "always" }),
    ).toThrow(/promptCache/);
    expect(() =>
      parseModelConfig({ ...anthropic, promptCacheTtl: "10m" }),
    ).toThrow(/promptCacheTtl/);
  });

  // The API requires a longer TTL to come before a shorter one, and the prefix comes first.
  test("a 1h conversation behind a 5m prefix is refused", () => {
    expect(() =>
      parseModelConfig({ ...anthropic, promptCacheConversationTtl: "1h" }),
    ).toThrow(/promptCacheConversationTtl/);
    expect(() =>
      parseModelConfig({
        ...anthropic,
        promptCacheTtl: "1h",
        promptCacheConversationTtl: "1h",
      }),
    ).not.toThrow();
  });

  // OpenRouter's usage carries one write count with no TTL, so a 1h write would be priced at 5m.
  test("openrouter refuses a 1h TTL and keeps 5m", () => {
    const or = { provider: "openrouter", model: "anthropic/claude-haiku-5.5" };
    expect(() => parseModelConfig({ ...or, promptCacheTtl: "1h" })).toThrow(
      /promptCacheTtl/,
    );
    expect(() =>
      parseModelConfig({
        ...or,
        promptCacheTtl: "5m",
        promptCacheConversationTtl: "1h",
      }),
    ).toThrow(/promptCacheConversationTtl/);
    expect(() =>
      parseModelConfig({ ...or, promptCache: "auto", promptCacheTtl: "5m" }),
    ).not.toThrow();
  });

  test("a provider that caches on its own refuses the fields", () => {
    expect(() =>
      parseModelConfig({
        provider: "openai",
        model: "gpt-5.6-luna",
        promptCache: "auto",
      }),
    ).toThrow(/promptCache/);
  });
});
