import { afterAll, describe, expect, test } from "bun:test";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { UsageCapture, type UsageRow } from "@/graph/usage";

// Issue #334, and the reason these drive the vendor adapters instead of asserting on a fake result:
// the defect was never in our arithmetic over a shape we control, it was in what an ADAPTER hands
// over. `@langchain/google-genai` maps `output_tokens` from `candidatesTokenCount` alone and reads
// `thoughtsTokenCount` nowhere — a hand-written `usage_metadata` fixture would have encoded that
// belief instead of testing it, which is exactly how the wrong number got into the ledger.
//
// So each server below answers in its own vendor's raw response shape, the real client parses it,
// and the assertion is on the ROW the ledger would have written.

// NOTE: happy-dom's `fetch` enforces same-origin (so every call is preflighted) and its `Response`
// is not the one Bun's socket layer recognises. Same two workarounds as
// tests/modules/guardrail-constrained.test.ts.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
const preflight = (req: Request) =>
  req.method === "OPTIONS"
    ? new BunResponse(null, { status: 204, headers: CORS })
    : null;

function serving(body: () => unknown) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const pre = preflight(req);
      if (pre) return pre;
      return BunResponse.json(body(), { headers: CORS });
    },
  });
}

// The one row the turn would have written, captured at the sink instead of the database.
async function rowFor(model: BaseChatModel, label: string): Promise<UsageRow> {
  const rows: UsageRow[] = [];
  await model.invoke("oi", {
    callbacks: [
      new UsageCapture({
        tenantId: 1n,
        model: label,
        node: "agent",
        persist: async (row) => {
          rows.push(row);
        },
      }),
    ],
  });
  expect(rows.length).toBe(1);
  return rows[0] as UsageRow;
}

// ── Gemini ──────────────────────────────────────────────────────────────────

const geminiUsage = {
  thinking: {
    promptTokenCount: 1200,
    candidatesTokenCount: 180,
    thoughtsTokenCount: 640,
    // NOTE: the API reference defines this as prompt + thoughts + candidates.
    totalTokenCount: 2020,
  },
  plain: {
    promptTokenCount: 1200,
    candidatesTokenCount: 180,
    totalTokenCount: 1380,
  },
};
let geminiMode: keyof typeof geminiUsage = "thinking";
const geminiServer = serving(() => ({
  candidates: [
    {
      content: { role: "model", parts: [{ text: "olá" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: geminiUsage[geminiMode],
}));

const gemini = () =>
  new ChatGoogleGenerativeAI({
    model: "gemini-3.5-flash",
    apiKey: "x",
    baseUrl: `http://localhost:${geminiServer.port}`,
  });

// ── Anthropic ───────────────────────────────────────────────────────────────

const anthropicServer = serving(() => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "olá" }],
  stop_reason: "end_turn",
  // NOTE: the three are ADDITIVE — `input_tokens` counts what was neither read from nor written
  // to cache.
  usage: {
    input_tokens: 30,
    output_tokens: 12,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 120,
  },
}));

// ── OpenAI ──────────────────────────────────────────────────────────────────

const openaiServer = serving(() => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-5.4-nano",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "olá" },
      finish_reason: "stop",
    },
  ],
  // NOTE: `prompt_tokens` already contains the cached part, and `completion_tokens` already
  // contains the reasoning. Both details are SUBSETS, and adding either is the mirror-image mistake.
  usage: {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens_details: { reasoning_tokens: 150 },
  },
}));

afterAll(() => {
  geminiServer.stop(true);
  anthropicServer.stop(true);
  openaiServer.stop(true);
});

describe("the ledger records what the provider billed", () => {
  test("Gemini bills its thinking as output, and the row carries it", async () => {
    geminiMode = "thinking";
    const row = await rowFor(gemini(), "gemini-3.5-flash");
    expect(row.promptTokens).toBe(1200);
    // NOTE: 180 candidates + 640 thoughts. Red before the fix: 180, and the 640 were billed to
    // nobody.
    expect(row.completionTokens).toBe(820);
  });

  test("a Gemini reply that did not think is unchanged", async () => {
    geminiMode = "plain";
    const row = await rowFor(gemini(), "gemini-3.5-flash");
    expect(row.promptTokens).toBe(1200);
    // NOTE: the control that keeps the repair from being a blanket addition — with no gap, nothing
    // is added.
    expect(row.completionTokens).toBe(180);
  });

  test("Anthropic's cache counters are inside the prompt total, not beside it", async () => {
    const row = await rowFor(
      new ChatAnthropic({
        model: "claude-haiku-4-5",
        apiKey: "x",
        clientOptions: { baseURL: `http://localhost:${anthropicServer.port}` },
      }),
      "claude-haiku-4-5",
    );
    // NOTE: 30 + 800 + 120, what the adapter itself sums in `buildUsageMetadata`, and what the row
    // means by `promptTokens` (a total, of which the cached counts are a discounted subset).
    expect(row.promptTokens).toBe(950);
    expect(row.completionTokens).toBe(12);
    expect(row.cachedReadTokens).toBe(800);
    expect(row.cacheCreationTokens).toBe(120);
  });

  test("OpenAI's cached prompt and reasoning output are subsets, never added on top", async () => {
    const row = await rowFor(
      new ChatOpenAI({
        model: "gpt-5.4-nano",
        apiKey: "x",
        configuration: { baseURL: `http://localhost:${openaiServer.port}` },
      }),
      "gpt-5.4-nano",
    );
    expect(row.promptTokens).toBe(1000);
    // NOTE: 200, NOT 350 — reasoning is already inside completion_tokens, and total is prompt +
    // completion exactly, so the Gemini repair must find no gap here.
    expect(row.completionTokens).toBe(200);
    expect(row.cachedReadTokens).toBe(800);
  });
});

// ── the premise the Gemini repair rests on ──────────────────────────────────

// `toolUsePromptTokenCount` is summed into Gemini's `totalTokenCount` too, and it is populated by
// Gemini's BUILT-IN tools (Search grounding, code execution, URL context). While none is enabled the
// gap is only thinking; enable one and part of it becomes prompt-side spend booked as output.
//
// The premise is therefore checked rather than trusted, and this is where the check lives.
const GEMINI_BUILTIN_TOOLS =
  /\b(googleSearch|google_search|googleSearchRetrieval|codeExecution|code_execution|urlContext|url_context)\b/;

function declaresBuiltinTool(source: string): boolean {
  return GEMINI_BUILTIN_TOOLS.test(source);
}

async function tsFilesUnder(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.ts");
  const out: string[] = [];
  for await (const f of glob.scan({ cwd: dir, absolute: true })) out.push(f);
  return out;
}

describe("no Gemini built-in tool is enabled", () => {
  // NOTE: a sweep that finds nothing passes whether the premise holds or the pattern is broken.
  test("the predicate recognises a built-in tool declaration", () => {
    expect(
      declaresBuiltinTool(`const g = model.bindTools([{ googleSearch: {} }]);`),
    ).toBe(true);
    expect(
      declaresBuiltinTool(
        `const g = model.bindTools([{ codeExecution: {} }]);`,
      ),
    ).toBe(true);
    expect(
      declaresBuiltinTool(`const g = model.bindTools(toGeminiTools(tools));`),
    ).toBe(false);
  });

  test("src/ enables none, so the total's gap is thinking alone", async () => {
    const offenders: string[] = [];
    for (const file of await tsFilesUnder(
      new URL("../../src", import.meta.url).pathname,
    )) {
      if (declaresBuiltinTool(await Bun.file(file).text())) {
        offenders.push(file.split("/src/")[1] as string);
      }
    }
    // NOTE: turning one on is allowed, but then `extractTokenUsage` has to stop attributing the
    // whole gap to generation, so this must be answered, not deleted.
    expect(offenders).toEqual([]);
  });
});
