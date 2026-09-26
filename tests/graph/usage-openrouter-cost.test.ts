import { afterAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LLMResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { createChatModel } from "@/graph/models";
import {
  addUsageGroup,
  defaultUsagePersist,
  emptyTurnUsage,
  OPENROUTER_REPORTED_PRICE_TABLE,
  recordDirectUsage,
  reportedCostUsd,
  sumTurnUsage,
  UsageCapture,
  type UsageRow,
} from "@/graph/usage";
import {
  cachedPriceOverrides,
  forgetPriceOverrides,
} from "@/modules/pricing/overrides";
import { callCostUsd } from "@/modules/pricing/price";
import { PRICE_TABLE_VERSION } from "@/modules/pricing/version";
import { getVisionProvider } from "@/modules/vision/providers";

// WHAT OPENROUTER SAID A CALL COST, recorded instead of the table's estimate (issue #866).
//
// Driven through the real `ChatOpenAI` against a server answering in OpenRouter's own response shape,
// for the same reason as tests/graph/usage-provider-counts.test.ts: whether the adapter hands the
// field over at all is the question, and a hand-written `response_metadata` fixture would answer it
// by assumption.

// NOTE: happy-dom's `fetch` enforces same-origin and its `Response` is not Bun's. Same workarounds as
// tests/graph/usage-provider-counts.test.ts.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;

const MODEL = "openai/gpt-5.4-mini";
const PROMPT = 1_000;
const COMPLETION = 100;
// What the table would say for the same counts, so a reported figure can be told apart from it.
const TABLE_COST = callCostUsd(
  "openrouter",
  MODEL,
  {
    promptTokens: PROMPT,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    completionTokens: COMPLETION,
  },
  new Date(),
);
const REPORTED = 0.004321;

function openrouterUsage(extra: Record<string, unknown>) {
  return {
    prompt_tokens: PROMPT,
    completion_tokens: COMPLETION,
    total_tokens: PROMPT + COMPLETION,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
    ...extra,
  };
}

function completion(usage: unknown, toolCall = false) {
  return {
    id: "gen-1",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    provider: "OpenAI",
    choices: [
      {
        index: 0,
        finish_reason: toolCall ? "tool_calls" : "stop",
        message: toolCall
          ? {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_current_time", arguments: "{}" },
                },
              ],
            }
          : { role: "assistant", content: "oi" },
      },
    ],
    usage,
  };
}

function sse(usage: unknown): string {
  const base = { id: "gen-1", object: "chat.completion.chunk", model: MODEL };
  const events = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "oi" } }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    { ...base, choices: [], usage },
  ];
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
}

const servers: { stop: (force?: boolean) => void }[] = [];
let streamedRequests = 0;
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function serving(respond: (streamed: boolean) => Response) {
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS")
        return new BunResponse(null, { status: 204, headers: CORS });
      const body = (await req.json()) as { stream?: boolean };
      if (body.stream === true) streamedRequests += 1;
      return respond(body.stream === true);
    },
  });
  servers.push(s);
  return `http://localhost:${s.port}/api/v1`;
}

function answering(usage: unknown, toolCall = false) {
  return serving((streamed) =>
    streamed
      ? new BunResponse(sse(usage), {
          headers: { ...CORS, "content-type": "text/event-stream" },
        })
      : BunResponse.json(completion(usage, toolCall), { headers: CORS }),
  );
}

function openrouterChat(baseURL: string): BaseChatModel {
  return createChatModel({
    provider: "openrouter",
    model: MODEL,
    apiKey: "test",
    temperature: 0.3,
    baseURL,
  } as Parameters<typeof createChatModel>[0]);
}

async function rowOf(
  model: { invoke: BaseChatModel["invoke"] },
  provider = "openrouter",
  tenantId = 1n,
  threadId: string | null = null,
): Promise<UsageRow> {
  const rows: UsageRow[] = [];
  await model.invoke("oi", {
    callbacks: [
      new UsageCapture({
        tenantId,
        threadId,
        provider,
        model: MODEL,
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

describe("an OpenRouter call records the cost OpenRouter reported", () => {
  test("the table can price this model, so a reported figure is told apart from it", () => {
    expect(TABLE_COST).not.toBeNull();
    expect(TABLE_COST).not.toBe(REPORTED);
  });

  test("the reported cost wins over the table, stamped as reported", async () => {
    const row = await rowOf(
      openrouterChat(answering(openrouterUsage({ cost: REPORTED }))),
    );
    expect(row.costUsd).toBe(REPORTED);
    expect(row.priceTable).toBe(OPENROUTER_REPORTED_PRICE_TABLE);
  });

  // Issue #865: a price the tenant wrote for the model is what the account says it pays, and it
  // comes before OpenRouter's figure as it comes before the table.
  test("a tenant's own price for the model wins over the reported cost", async () => {
    const tenant = 866_865n;
    await cachedPriceOverrides(tenant, async () => ({
      overrides: [
        { provider: "openrouter", model: MODEL, input: 1, output: 2 },
      ],
      updatedAt: "2026-09-25T12:00:00.000Z",
    }));
    try {
      const row = await rowOf(
        openrouterChat(answering(openrouterUsage({ cost: REPORTED }))),
        "openrouter",
        tenant,
      );
      expect(row.costUsd).toBeCloseTo((PROMPT * 1 + COMPLETION * 2) / 1e6, 12);
      expect(row.priceTable).toBe("tenant-override@2026-09-25T12:00:00.000Z");
    } finally {
      forgetPriceOverrides(tenant);
    }
  });

  // The popover says where a figure came from, so the turn and the ledger's readers count these
  // calls apart from the table's.
  test("the turn and a ledger group count the reported calls apart", async () => {
    const { usage } = await sumTurnUsage("or-866-turn", () =>
      rowOf(
        openrouterChat(answering(openrouterUsage({ cost: REPORTED }))),
        "openrouter",
        1n,
        "or-866-turn",
      ),
    );
    expect([usage.calls, usage.reportedPricedCalls]).toEqual([1, 1]);
    const group = {
      node: "agent",
      calls: 3,
      promptTokens: 0,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
      completionTokens: 0,
      costUsd: 0.01,
      pricedCalls: 2,
    };
    const into = emptyTurnUsage();
    addUsageGroup(into, {
      ...group,
      priceTable: OPENROUTER_REPORTED_PRICE_TABLE,
    });
    addUsageGroup(into, { ...group, priceTable: PRICE_TABLE_VERSION });
    expect([into.reportedPricedCalls, into.tenantPricedCalls]).toEqual([2, 0]);
  });

  test("a tool-calling response carries it just the same", async () => {
    const getCurrentTime = tool(async () => "12:00", {
      name: "get_current_time",
      description: "now",
      schema: z.object({}),
    });
    const chat = openrouterChat(
      answering(openrouterUsage({ cost: REPORTED }), true),
    );
    const bound = chat.bindTools?.([getCurrentTime]);
    if (!bound) throw new Error("openrouter chat cannot bind tools");
    const row = await rowOf(bound);
    expect(row.costUsd).toBe(REPORTED);
    expect(row.priceTable).toBe(OPENROUTER_REPORTED_PRICE_TABLE);
  });

  // The factory does not stream today; this holds the day a caller does, since OpenRouter puts the
  // usage on the last SSE event and the adapter copies it onto its final chunk.
  test("a streamed response carries it on the last event", async () => {
    const chat = openrouterChat(answering(openrouterUsage({ cost: REPORTED })));
    const streamedBefore = streamedRequests;
    const rows: UsageRow[] = [];
    const stream = await chat.stream("oi", {
      callbacks: [
        new UsageCapture({
          tenantId: 1n,
          provider: "openrouter",
          model: MODEL,
          persist: async (row) => {
            rows.push(row);
          },
        }),
      ],
    });
    for await (const _ of stream) {
      // NOTE: drained so the run ends and the capture sees it.
    }
    expect(streamedRequests).toBe(streamedBefore + 1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.costUsd).toBe(REPORTED);
    expect(rows[0]?.priceTable).toBe(OPENROUTER_REPORTED_PRICE_TABLE);
  });

  test("a zero cost is a reported figure, not an absent one", async () => {
    const row = await rowOf(
      openrouterChat(answering(openrouterUsage({ cost: 0 }))),
    );
    expect(row.costUsd).toBe(0);
    expect(row.priceTable).toBe(OPENROUTER_REPORTED_PRICE_TABLE);
  });
});

describe("an OpenRouter call with no usable cost falls back to the table", () => {
  const fallsBack = (label: string, usage: unknown) =>
    test(label, async () => {
      const row = await rowOf(openrouterChat(answering(usage)));
      expect(row.costUsd).toBe(TABLE_COST);
      expect(row.priceTable).toBe(PRICE_TABLE_VERSION);
    });

  fallsBack("absent", openrouterUsage({}));
  fallsBack("a string", openrouterUsage({ cost: "0.004321" }));
  fallsBack("negative", openrouterUsage({ cost: -0.01 }));
  fallsBack("null", openrouterUsage({ cost: null }));
  // BYOK: OpenRouter's credits pay only its fee, the inference is billed to the operator's own key.
  fallsBack("a BYOK call", openrouterUsage({ cost: 0.0002, is_byok: true }));
});

// JSON cannot carry them, but the bag is untyped and a figure that is not finite is no figure.
test("a non-finite cost is not a figure", () => {
  const withCost = (cost: number) =>
    ({
      generations: [
        [{ text: "", message: { response_metadata: { usage: { cost } } } }],
      ],
    }) as unknown as LLMResult;
  expect(
    reportedCostUsd("openrouter", withCost(Number.POSITIVE_INFINITY)),
  ).toBeNull();
  expect(reportedCostUsd("openrouter", withCost(Number.NaN))).toBeNull();
  expect(reportedCostUsd("openrouter", withCost(0.5))).toBe(0.5);
});

describe("another provider's `cost` field is not read", () => {
  test("an openai call priced by the table, whatever the response says", async () => {
    const chat = new ChatOpenAI({
      model: MODEL,
      apiKey: "test",
      configuration: {
        baseURL: answering(openrouterUsage({ cost: REPORTED })),
      },
    });
    const rows: UsageRow[] = [];
    await chat.invoke("oi", {
      callbacks: [
        new UsageCapture({
          tenantId: 1n,
          provider: "openai",
          model: "gpt-5.4-mini",
          persist: async (row) => {
            rows.push(row);
          },
        }),
      ],
    });
    expect(rows[0]?.costUsd).toBe(
      callCostUsd(
        "openai",
        "gpt-5.4-mini",
        {
          promptTokens: PROMPT,
          cachedReadTokens: 0,
          cacheCreationTokens: 0,
          completionTokens: COMPLETION,
        },
        new Date(),
      ),
    );
    expect(rows[0]?.costUsd).not.toBe(REPORTED);
    expect(rows[0]?.priceTable).toBe(PRICE_TABLE_VERSION);
  });
});

// The column the row lands in: the per-row value reaches `llm_usage.price_table`, and a row that
// names none keeps the table's version.
const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

// The image reader calls OpenRouter by raw fetch, outside LangChain, and reads the same `usage`.
describe("the image reader's OpenRouter call carries the reported cost", () => {
  const visionFetch = (usage: unknown) =>
    (async () =>
      BunResponse.json({
        choices: [{ message: { content: "a receipt" } }],
        usage,
      })) as unknown as typeof fetch;
  const req = (fetchImpl: typeof fetch) => ({
    bytes: new ArrayBuffer(4),
    mimeType: "image/png",
    kind: "image" as const,
    prompt: "read it",
    model: MODEL,
    apiKey: "test",
    baseURL: "http://vision.test/api/v1",
    fetchImpl,
    timeoutMs: 5_000,
  });
  const usage = { prompt_tokens: PROMPT, completion_tokens: COMPLETION };

  test("OpenRouter's figure comes back with the counts; a BYOK call's and another provider's do not", async () => {
    const or = getVisionProvider("openrouter");
    const oa = getVisionProvider("openai");
    const hit = await or?.extract(
      req(visionFetch({ ...usage, cost: REPORTED })),
    );
    expect(hit?.usage?.reportedCostUsd).toBe(REPORTED);
    expect(hit?.usage?.promptTokens).toBe(PROMPT);
    const byok = await or?.extract(
      req(visionFetch({ ...usage, cost: REPORTED, is_byok: true })),
    );
    expect(byok?.usage?.reportedCostUsd).toBeUndefined();
    const other = await oa?.extract(
      req(visionFetch({ ...usage, cost: REPORTED })),
    );
    expect(other?.usage?.reportedCostUsd).toBeUndefined();
  });
});

describe.skipIf(!dbUp)(
  "the ledger row carries where its cost came from",
  () => {
    const suDb = su as PrismaClient;
    const appDb = app as PrismaClient;
    let tenantId = 0n;

    afterAll(async () => {
      if (tenantId) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM llm_usage WHERE tenant_id = ${tenantId}`,
        );
        await suDb.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("reported and table rows are stamped apart", async () => {
      const t = await suDb.tenant.create({
        data: { name: "OR-COST", slug: `or-cost-${process.pid}` },
      });
      tenantId = t.id;
      const persist = defaultUsagePersist(appDb);
      const base = {
        tenantId,
        agentId: null,
        conversationId: null,
        inboxId: null,
        turnId: null,
        model: MODEL,
        node: "agent",
        source: "playground" as const,
        promptTokens: PROMPT,
        completionTokens: COMPLETION,
        cachedReadTokens: 0,
        cacheCreationTokens: 0,
        durationMs: null,
      };
      await persist({
        ...base,
        threadId: "or-reported",
        costUsd: REPORTED,
        priceTable: OPENROUTER_REPORTED_PRICE_TABLE,
      });
      await persist({
        ...base,
        threadId: "or-table",
        costUsd: TABLE_COST,
        priceTable: PRICE_TABLE_VERSION,
      });
      const rows = await suDb.llmUsage.findMany({
        where: { tenantId },
        select: { threadId: true, costUsd: true, priceTable: true },
        orderBy: { id: "asc" },
      });
      expect(
        rows.map((r) => [r.threadId, Number(r.costUsd), r.priceTable]),
      ).toEqual([
        ["or-reported", REPORTED, OPENROUTER_REPORTED_PRICE_TABLE],
        ["or-table", TABLE_COST, PRICE_TABLE_VERSION],
      ]);
    });

    test("a direct call's reported cost is written as reported", async () => {
      await recordDirectUsage(
        {
          tenantId,
          turnId: "t-or-vision",
          threadId: "or-vision",
          source: "playground",
          base: appDb,
        },
        {
          provider: "openrouter",
          model: MODEL,
          node: "vision",
          promptTokens: PROMPT,
          completionTokens: COMPLETION,
          reportedCostUsd: REPORTED,
        },
      );
      const row = await suDb.llmUsage.findFirst({
        where: { tenantId, threadId: "or-vision" },
        select: { costUsd: true, priceTable: true },
      });
      expect([Number(row?.costUsd), row?.priceTable]).toEqual([
        REPORTED,
        OPENROUTER_REPORTED_PRICE_TABLE,
      ]);
    });
  },
);
