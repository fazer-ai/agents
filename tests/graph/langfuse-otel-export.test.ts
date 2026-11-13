import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { type RunnableConfig, RunnableLambda } from "@langchain/core/runnables";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { startObservation } from "@langfuse/tracing";
import logger from "@/api/lib/logger";
import config from "@/config";
import { TRUNCATED_MARKER, traceIdForTurn } from "@/graph/langfuse-otel";
import {
  buildLangfuseHandler,
  type LangfuseConfig,
  recordDirectGeneration,
  setLangfuseDeliveryRetryForTest,
  shutdownLangfuseClients,
  type TraceContext,
} from "@/graph/observability";
import {
  type FlatSpan,
  jsonAttr,
  LANGFUSE_OTLP_PATH,
  meta,
  otlpSpans,
} from "../utils/otlp-capture";

// Every turn here is traced against a stubbed `fetch`, and what the stub records is read after
// `shutdownLangfuseClients()` drains the queue. The stub answers the OTLP endpoint and the legacy
// ingestion endpoint alike, so a run that still used the legacy one finishes cleanly and is told
// apart only by WHERE it posted.

const OTLP = LANGFUSE_OTLP_PATH;
const LEGACY = "/api/public/ingestion";

interface Posted {
  url: string;
  auth: string | null;
  body: string;
}

let posted: Posted[] = [];
let failWith: number | null = null;
let answerWith: string | null = null;
let hang = false;
let inFlight = 0;
const realFetch = globalThis.fetch;

beforeAll(() => {
  setLangfuseDeliveryRetryForTest({ fetchRetryCount: 1, fetchRetryDelay: 1 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("http://lf-")) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body =
      typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : String(raw ?? "");
    posted.push({ url, auth: headers.get("authorization"), body });
    if (hang) {
      inFlight++;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          inFlight--;
          reject(new Error("aborted by the exporter"));
        });
      });
    }
    if (failWith) return new Response("nope", { status: failWith });
    if (answerWith) return new Response(answerWith, { status: 200 });
    if (url.endsWith(LEGACY)) {
      return new Response(JSON.stringify({ successes: [], errors: [] }), {
        status: 207,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  await shutdownLangfuseClients();
  posted = [];
  failWith = null;
  answerWith = null;
  hang = false;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setLangfuseDeliveryRetryForTest(undefined);
});

function cfgFor(
  tenant: string,
  extra: Partial<LangfuseConfig> = {},
): LangfuseConfig {
  return {
    publicKey: `pk-lf-${tenant}`,
    secretKey: `sk-lf-${tenant}`,
    baseUrl: `http://lf-${tenant}.test`,
    tenantSlug: `slug-${tenant}`,
    ...extra,
  };
}

function basic(tenant: string): string {
  return `Basic ${Buffer.from(`pk-lf-${tenant}:sk-lf-${tenant}`).toString("base64")}`;
}

function spansAt(tenant: string): FlatSpan[] {
  return otlpSpans(
    posted
      .filter((p) => p.url === `http://lf-${tenant}.test${OTLP}`)
      .map((p) => p.body),
  );
}

/** One turn as the runtime runs it: a top-level chain that calls the chat model once. */
async function runTurn(
  cfg: LangfuseConfig,
  ctx: TraceContext,
  message: string,
  reply: string,
): Promise<void> {
  const handler = buildLangfuseHandler(cfg, ctx);
  expect(handler).not.toBeNull();
  const model = new FakeListChatModel({ responses: [reply] });
  const turn = RunnableLambda.from(
    async (input: { content: string }, runConfig?: RunnableConfig) =>
      (await model.invoke(input.content, runConfig)).content,
  ).withConfig({ runName: "agent-turn" });
  await turn.invoke({ content: message }, { callbacks: [handler as never] });
}

/** A secondary model call (a guardrail, the speech normalizer) under the same turn. */
async function runSecondary(
  cfg: LangfuseConfig,
  ctx: TraceContext,
  prompt: string,
): Promise<void> {
  const handler = buildLangfuseHandler(cfg, { ...ctx, updateRoot: false });
  const model = new FakeListChatModel({ responses: ["verdict: ok"] });
  await model.invoke(prompt, { callbacks: [handler as never] });
}

const TURN_A = "8f14e45f-ceea-467a-9575-6c7e0d3b1f20";
const TURN_B = "c9f0f895-fb98-4b91-9f1a-1b2c3d4e5f60";
const traceIdOf = (turnId: string) => turnId.replace(/-/g, "");

describe("langfuse export over OTLP", () => {
  test("a turn is delivered to the tenant's OTLP endpoint with its keys, never to the legacy ingestion", async () => {
    await runTurn(
      cfgFor("a", { sendContent: true }),
      {
        tenantId: 11n,
        threadId: "11:5:42",
        turnId: TURN_A,
        userId: "slug-a",
        conversationId: 42n,
        agentId: 5n,
        source: "inbox",
        availableTools: ["handoff_to_human", "set_labels"],
      },
      "quero agendar amanhã",
      "Claro, às 10h?",
    );
    await shutdownLangfuseClients();

    expect(posted.some((p) => p.url.endsWith(LEGACY))).toBe(false);
    const toA = posted.filter((p) => p.url === `http://lf-a.test${OTLP}`);
    expect(toA.length).toBeGreaterThan(0);
    for (const p of toA) expect(p.auth).toBe(basic("a"));

    const spans = spansAt("a");
    expect(new Set(spans.map((s) => s.traceId))).toEqual(
      new Set([traceIdOf(TURN_A)]),
    );
    const root = spans.find((s) => !s.parentSpanId);
    expect(root?.name).toBe("agent-turn");
    const a = root?.attrs ?? {};
    expect(a["session.id"]).toBe("11:5:42");
    expect(a["user.id"]).toBe("slug-a");
    expect(a["langfuse.environment"]).toBe(config.env);
    expect(meta(a, "tenantId")).toBe("11");
    expect(meta(a, "turnId")).toBe(TURN_A);
    expect(meta(a, "conversationId")).toBe("42");
    expect(meta(a, "agentId")).toBe("5");
    expect(meta(a, "availableTools")).toEqual([
      "handoff_to_human",
      "set_labels",
    ]);
    expect(String(a["langfuse.trace.input"])).toContain("quero agendar amanhã");
    expect(String(a["langfuse.trace.output"])).toContain("Claro, às 10h?");
    const generation = spans.find(
      (s) => s.attrs["langfuse.observation.type"] === "generation",
    );
    expect(generation?.parentSpanId).toBe(root?.spanId);
    expect(spans.some((s) => meta(s.attrs, "ls_model_type") === "chat")).toBe(
      true,
    );
    expect(generation?.attrs["session.id"]).toBe("11:5:42");
  });

  test("two tenants tracing at once each receive only their own spans", async () => {
    await Promise.all([
      runTurn(
        cfgFor("a"),
        { tenantId: 11n, threadId: "11:1:1", turnId: TURN_A, userId: "slug-a" },
        "msg a",
        "reply a",
      ),
      runTurn(
        cfgFor("b"),
        { tenantId: 22n, threadId: "22:1:1", turnId: TURN_B, userId: "slug-b" },
        "msg b",
        "reply b",
      ),
    ]);
    await shutdownLangfuseClients();

    const a = spansAt("a");
    const b = spansAt("b");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(new Set(a.map((s) => s.traceId))).toEqual(
      new Set([traceIdOf(TURN_A)]),
    );
    expect(new Set(b.map((s) => s.traceId))).toEqual(
      new Set([traceIdOf(TURN_B)]),
    );
    expect(a.every((s) => meta(s.attrs, "tenantId") === "11")).toBe(true);
    expect(b.every((s) => meta(s.attrs, "tenantId") === "22")).toBe(true);
    for (const p of posted.filter((p) => p.url.startsWith("http://lf-b.test")))
      expect(p.auth).toBe(basic("b"));
  });

  test("two tenants whose handlers share a turn id each still deliver only to their own project", async () => {
    const ctxA = { tenantId: 11n, threadId: "11:1:1", turnId: TURN_A };
    const ctxB = { tenantId: 22n, threadId: "22:1:1", turnId: TURN_A };
    const handlerA = buildLangfuseHandler(cfgFor("a"), ctxA);
    const cfgB = cfgFor("b", { sendContent: true });
    const handlerB = buildLangfuseHandler(cfgB, ctxB);
    const run = async (handler: unknown, text: string) => {
      const model = new FakeListChatModel({ responses: [`reply ${text}`] });
      await RunnableLambda.from(
        async (input: { content: string }, runConfig?: RunnableConfig) =>
          (await model.invoke(input.content, runConfig)).content,
      )
        .withConfig({ runName: "agent-turn" })
        .invoke({ content: text }, { callbacks: [handler as never] });
    };
    await run(handlerB, "from-tenant-b");
    await run(handlerA, "from-tenant-a");
    await runSecondary(cfgB, ctxB, "tenant-b guardrail");
    await shutdownLangfuseClients();

    const a = spansAt("a");
    const b = spansAt("b");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.every((s) => meta(s.attrs, "tenantId") === "11")).toBe(true);
    expect(b.every((s) => meta(s.attrs, "tenantId") === "22")).toBe(true);
    const rootB = b.find((s) => s.name === "agent-turn");
    const guardB = b.find((s) =>
      String(s.attrs["langfuse.observation.input"] ?? "").includes(
        "tenant-b guardrail",
      ),
    );
    expect(guardB?.parentSpanId).toBe(rootB?.spanId);
  });

  test("a span started outside every handler is delivered nowhere", async () => {
    await runTurn(
      cfgFor("a"),
      { tenantId: 11n, threadId: "11:1:1", turnId: TURN_A },
      "x",
      "y",
    );
    startObservation("stray-span", {}).end();
    await shutdownLangfuseClients();
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.some((p) => p.body.includes("stray-span"))).toBe(false);
  });

  test("without the content opt-in no message or reply byte leaves the process; with it, they do", async () => {
    await runTurn(
      cfgFor("a"),
      { tenantId: 11n, threadId: "11:1:1", turnId: TURN_A },
      "marker-MA-7731",
      "reply-RA-7731",
    );
    await runTurn(
      cfgFor("b", { sendContent: true }),
      { tenantId: 22n, threadId: "22:1:1", turnId: TURN_B },
      "marker-MB-7731",
      "reply-RB-7731",
    );
    await shutdownLangfuseClients();

    const toA = posted.filter((p) => p.url.startsWith("http://lf-a.test"));
    expect(toA.length).toBeGreaterThan(0);
    for (const p of toA) {
      expect(p.body).not.toContain("marker-MA-7731");
      expect(p.body).not.toContain("reply-RA-7731");
    }
    expect(
      spansAt("a").some(
        (s) => s.attrs["langfuse.observation.type"] === "generation",
      ),
    ).toBe(true);
    const toB = posted
      .filter((p) => p.url.startsWith("http://lf-b.test"))
      .map((p) => p.body)
      .join("");
    expect(toB).toContain("marker-MB-7731");
    expect(toB).toContain("reply-RB-7731");
  });

  test("a secondary call joins the turn's trace under its root and does not take the trace's input or output", async () => {
    const cfg = cfgFor("a", { sendContent: true });
    const ctx = {
      tenantId: 11n,
      threadId: "11:1:1",
      turnId: TURN_A,
      userId: "slug-a",
    };
    await runTurn(cfg, ctx, "pergunta do cliente", "resposta do agente");
    await runSecondary(cfg, ctx, "guardrail prompt");
    await shutdownLangfuseClients();

    const spans = spansAt("a");
    expect(new Set(spans.map((s) => s.traceId))).toEqual(
      new Set([traceIdOf(TURN_A)]),
    );
    const root = spans.find((s) => s.name === "agent-turn");
    const secondary = spans.find((s) =>
      String(s.attrs["langfuse.observation.input"] ?? "").includes(
        "guardrail prompt",
      ),
    );
    expect(secondary?.parentSpanId).toBe(root?.spanId);
    const traceInputs = spans
      .map((s) => s.attrs["langfuse.trace.input"])
      .filter((v) => v !== undefined);
    expect(traceInputs).toHaveLength(1);
    expect(String(traceInputs[0])).toContain("pergunta do cliente");
    expect(
      spans.filter((s) => s.attrs["langfuse.trace.output"] !== undefined),
    ).toHaveLength(1);
    expect(secondary?.attrs["user.id"]).toBe("slug-a");
    expect(secondary?.attrs["langfuse.internal.is_app_root"]).not.toBe(true);
    expect(root?.attrs["langfuse.internal.is_app_root"]).toBe(true);
  });

  test("in the runtime's order (turn handler, then an input guardrail before the turn, then a later call) the later call still lands under the root", async () => {
    const cfg = cfgFor("a", { sendContent: true });
    const ctx = {
      tenantId: 11n,
      threadId: "11:1:1",
      turnId: TURN_A,
      userId: "slug-a",
    };
    const turnHandler = buildLangfuseHandler(cfg, ctx);
    await runSecondary(cfg, ctx, "input guardrail prompt");
    const model = new FakeListChatModel({ responses: ["resposta"] });
    await RunnableLambda.from(
      async (input: { content: string }, runConfig?: RunnableConfig) =>
        (await model.invoke(input.content, runConfig)).content,
    )
      .withConfig({ runName: "agent-turn" })
      .invoke({ content: "pergunta" }, { callbacks: [turnHandler as never] });
    await runSecondary(cfg, ctx, "speech normalizer prompt");
    await shutdownLangfuseClients();

    const spans = spansAt("a");
    const root = spans.find((s) => s.name === "agent-turn");
    const byInput = (text: string) =>
      spans.find((s) =>
        String(s.attrs["langfuse.observation.input"] ?? "").includes(text),
      );
    expect(byInput("speech normalizer prompt")?.parentSpanId).toBe(
      root?.spanId,
    );
    const early = byInput("input guardrail prompt");
    expect(early?.traceId).toBe(traceIdOf(TURN_A));
    expect(early?.attrs["langfuse.internal.is_app_root"]).not.toBe(true);
    expect(
      spans
        .filter((s) => s.attrs["langfuse.internal.is_app_root"] === true)
        .map((s) => s.spanId),
    ).toEqual([String(root?.spanId)]);
  });

  test("a span whose content alone is over the request limit still lands, its text cut", async () => {
    const huge = "x".repeat(5_000_000);
    await runTurn(
      cfgFor("a", { sendContent: true }),
      { tenantId: 11n, threadId: "11:1:1", turnId: TURN_A },
      huge,
      "ok",
    );
    await shutdownLangfuseClients();

    const toA = posted.filter((p) => p.url === `http://lf-a.test${OTLP}`);
    expect(toA.length).toBeGreaterThan(0);
    for (const p of toA) expect(p.body.length).toBeLessThanOrEqual(3_500_000);
    const spans = spansAt("a");
    const root = spans.find((s) => s.name === "agent-turn");
    expect(String(root?.attrs["langfuse.trace.input"])).toContain(
      TRUNCATED_MARKER,
    );
    expect(
      spans.some((s) => s.attrs["langfuse.observation.type"] === "generation"),
    ).toBe(true);
  });

  test("a generation written by hand lands in the turn's trace with its model and usage", async () => {
    const ok = recordDirectGeneration(
      cfgFor("a"),
      {
        tenantId: 11n,
        turnId: TURN_A,
        threadId: "11:1:1",
        source: "playground",
      },
      {
        name: "vision",
        model: "gpt-4o-mini",
        promptTokens: 120,
        completionTokens: 30,
        cachedReadTokens: 20,
      },
    );
    expect(ok).toBe(true);
    await shutdownLangfuseClients();

    const spans = spansAt("a");
    const gen = spans.find((s) => s.name === "vision");
    expect(gen?.traceId).toBe(traceIdOf(TURN_A));
    expect(gen?.attrs["langfuse.observation.type"]).toBe("generation");
    expect(gen?.attrs["langfuse.observation.model.name"]).toBe("gpt-4o-mini");
    expect(
      jsonAttr(gen?.attrs ?? {}, "langfuse.observation.usage_details"),
    ).toEqual({
      input: 100,
      output: 30,
      total: 150,
      input_cache_read: 20,
    });
    expect(gen?.attrs["langfuse.environment"]).toBe(`${config.env}-playground`);
    expect(gen?.attrs["session.id"]).toBe("11:1:1");
  });

  test("a refused delivery is logged once per distinct failure and the drain still settles", async () => {
    failWith = 500;
    const warn = spyOn(logger, "warn");
    try {
      for (const turnId of [TURN_A, TURN_B]) {
        await runTurn(
          cfgFor("fail"),
          { tenantId: 33n, threadId: "33:1:1", turnId },
          "x",
          "y",
        );
        await shutdownLangfuseClients();
        if (turnId === TURN_A) {
          // NOTE: One batch, retried once by the test's retry setting: two attempts.
          expect(
            posted.filter((p) => p.url.startsWith("http://lf-fail.test")),
          ).toHaveLength(2);
        }
      }
      const lines = warn.mock.calls.filter((c) =>
        String(c[1] ?? "").includes("langfuse trace delivery failed"),
      );
      expect(
        posted.filter((p) => p.url.startsWith("http://lf-fail.test")).length,
      ).toBeGreaterThan(1);
      expect(lines).toHaveLength(1);
      const meta = lines[0]?.[0] as Record<string, unknown>;
      expect(meta.tenantId).toBe("33");
      expect(JSON.stringify(lines)).not.toContain("sk-lf-fail");
    } finally {
      warn.mockRestore();
    }
  });

  test("a 200 that rejects spans is a failed delivery, logged and not retried", async () => {
    answerWith = JSON.stringify({
      partialSuccess: { rejectedSpans: 2, errorMessage: "schema mismatch" },
    });
    const warn = spyOn(logger, "warn");
    try {
      await runTurn(
        cfgFor("partial"),
        { tenantId: 44n, threadId: "44:1:1", turnId: TURN_A },
        "x",
        "y",
      );
      await shutdownLangfuseClients();
      expect(
        posted.filter((p) => p.url.startsWith("http://lf-partial.test")),
      ).toHaveLength(1);
      const lines = warn.mock.calls.filter((c) =>
        String(c[1] ?? "").includes("langfuse trace delivery failed"),
      );
      expect(lines).toHaveLength(1);
      expect(String((lines[0]?.[0] as { detail?: string }).detail)).toContain(
        "2 span(s) rejected",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("an export that never answers is abandoned within its budget, and the drain waits for it", async () => {
    hang = true;
    setLangfuseDeliveryRetryForTest({
      fetchRetryCount: 3,
      fetchRetryDelay: 1,
      budgetMs: 300,
    });
    try {
      await runTurn(
        cfgFor("hang"),
        { tenantId: 55n, threadId: "55:1:1", turnId: TURN_A },
        "x",
        "y",
      );
      const started = Date.now();
      await shutdownLangfuseClients();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(inFlight).toBe(0);
      expect(
        posted.filter((p) => p.url.startsWith("http://lf-hang.test")).length,
      ).toBeGreaterThan(0);
    } finally {
      setLangfuseDeliveryRetryForTest({
        fetchRetryCount: 1,
        fetchRetryDelay: 1,
      });
    }
  });

  test("no config, no handler, nothing posted", async () => {
    expect(
      buildLangfuseHandler(null, { tenantId: 1n, threadId: "1:1:1" }),
    ).toBeNull();
    await shutdownLangfuseClients();
    expect(posted).toHaveLength(0);
  });
});

describe("traceIdForTurn", () => {
  test("a UUID turn id is its own trace id without dashes; any other is hashed to 32 hex digits", () => {
    expect(traceIdForTurn(TURN_A)).toBe(traceIdOf(TURN_A));
    const hashed = traceIdForTurn("nudge:42:1700000000");
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdForTurn("nudge:42:1700000000")).toBe(hashed);
    expect(traceIdForTurn("nudge:42:1700000001")).not.toBe(hashed);
  });
});
