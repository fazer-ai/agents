import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  getVisionProvider,
  VisionError,
  type VisionProvider,
  type VisionRequest,
} from "@/modules/vision/providers";
import {
  attemptBudgetMs,
  isTransientVisionFailure,
  retryDelayMs,
  VISION_IMAGE_CEILING_MS,
  VISION_MAX_ATTEMPTS,
  VISION_RETRY_DELAYS_MS,
  VISION_TOTAL_BUDGET_MS,
} from "@/modules/vision/retry";
import {
  extractInboundFile,
  extractWithRetry,
  resolveVisionConfig,
} from "@/modules/vision/service";
import type { VisionConfig } from "@/modules/vision/settings";
import { seedChatwootInstance } from "../utils/chatwoot";

// A class that names a timeout without setting `name` — both vendor SDKs do this, which is why the
// shared reducer matches the CONSTRUCTOR name too.
class APIConnectionTimeoutError extends Error {}

describe("isTransientVisionFailure", () => {
  // Whether asking the same provider the same question again could answer differently.
  const table: Array<[string, unknown, boolean]> = [
    ["408 request timeout", new VisionError("gemini", 408), true],
    ["429 rate limited", new VisionError("gemini", 429), true],
    ["500 internal", new VisionError("gemini", 500), true],
    ["502 bad gateway", new VisionError("gemini", 502), true],
    ["503 overloaded", new VisionError("gemini", 503), true],
    ["504 gateway timeout", new VisionError("gemini", 504), true],
    ["529 anthropic overloaded", new VisionError("anthropic", 529), true],
    ["400 bad request", new VisionError("gemini", 400), false],
    ["401 bad key", new VisionError("gemini", 401), false],
    ["403 forbidden", new VisionError("gemini", 403), false],
    ["404 unknown model", new VisionError("gemini", 404), false],
    ["413 too large", new VisionError("gemini", 413), false],
    ["422 unprocessable", new VisionError("gemini", 422), false],
    // AbortSignal.timeout rejects with a DOMException named TimeoutError (measured on Bun 1.4).
    [
      "the attempt budget expiring",
      new DOMException("The operation timed out.", "TimeoutError"),
      true,
    ],
    ["an SDK timeout class", new APIConnectionTimeoutError("timed out"), true],
    // A connection that never opened: reads transient, is just as often a base URL that will never
    // resolve, and the operator needs that to fail on the first attempt.
    [
      "a connection that never opened",
      new TypeError("Unable to connect."),
      false,
    ],
    ["an error with nothing to go on", new Error("boom"), false],
    // A status is only read off a numeric field of a real Error — a bag that merely looks like one
    // is not evidence, and neither is a status spelled as text.
    ["a plain object with a status", { status: 503 }, false],
    [
      "a status spelled as text",
      Object.assign(new Error("x"), { status: "503" }),
      false,
    ],
    ["nothing at all", null, false],
  ];
  for (const [name, err, want] of table) {
    test(`${name} → ${want ? "ask again" : "give up"}`, () => {
      expect(isTransientVisionFailure(err)).toBe(want);
    });
  }
});

describe("retryDelayMs", () => {
  test("the first attempt is immediate, and the retry waits with jitter that only adds", () => {
    expect(retryDelayMs(1, () => 0)).toBe(0);
    expect(retryDelayMs(1, () => 1)).toBe(0);
    expect(retryDelayMs(2, () => 0)).toBe(VISION_RETRY_DELAYS_MS[0] as number);
    expect(retryDelayMs(2, () => 1)).toBe(
      (VISION_RETRY_DELAYS_MS[0] as number) * 1.5,
    );
  });

  test("past the last attempt there is no delay to give, and null says so", () => {
    expect(retryDelayMs(VISION_MAX_ATTEMPTS + 1, () => 0)).toBeNull();
  });
});

describe("attemptBudgetMs", () => {
  const at = (
    kind: "image" | "document",
    attempt: number,
    elapsedMs: number,
    customEndpoint = false,
  ) => attemptBudgetMs({ kind, attempt, elapsedMs, customEndpoint });

  test("a non-final attempt is capped only where a measurement backs the cap", () => {
    expect(at("image", 1, 0)).toBe(VISION_IMAGE_CEILING_MS);
    // Unmeasured, both of them: a document is 25MB and ~100 pages of provider work, and a custom
    // `baseURL` is the operator's own hardware. Cutting either at 20s would turn a slow SUCCESS
    // into a permanent marker, so they keep the whole total, exactly as the single call had it.
    expect(at("document", 1, 0)).toBe(VISION_TOTAL_BUDGET_MS);
    expect(at("image", 1, 0, true)).toBe(VISION_TOTAL_BUDGET_MS);
  });

  test("the LAST attempt is capped only by the total, so a slow call still has its window", () => {
    // 20s spent on a first attempt that timed out, plus the wait: the second is NOT cut at 20s
    // again — that is what keeps a legitimately slow endpoint from becoming a permanent marker.
    const left = VISION_TOTAL_BUDGET_MS - 20_750;
    expect(at("image", VISION_MAX_ATTEMPTS, 20_750)).toBe(left);
    expect(left).toBeGreaterThan(VISION_IMAGE_CEILING_MS);
  });

  test("no attempt gets more than what is left of the total", () => {
    expect(at("document", 1, 3_000)).toBe(VISION_TOTAL_BUDGET_MS - 3_000);
    expect(at("image", 1, 45_000)).toBe(VISION_TOTAL_BUDGET_MS - 45_000);
  });

  test("a remainder too short to answer is no budget at all", () => {
    // 500ms buys a timeout, not an extraction: the fastest measured call is 2.0s.
    expect(at("document", 2, 59_500)).toBeNull();
    expect(at("image", 2, VISION_TOTAL_BUDGET_MS)).toBeNull();
  });

  test("the whole retried extraction still fits the budget one call used to have", () => {
    for (const [kind, customEndpoint] of [
      ["image", false],
      ["document", false],
      ["image", true],
    ] as const) {
      let elapsed = 0;
      for (let attempt = 1; attempt <= VISION_MAX_ATTEMPTS; attempt++) {
        // rand at its maximum: the longest waits this policy can produce.
        const delay = retryDelayMs(attempt, () => 1);
        if (delay === null) break;
        // The loop's own order: a wait is only spent when what follows it can still fund a call.
        const budget = attemptBudgetMs({
          kind,
          attempt,
          elapsedMs: elapsed + delay,
          customEndpoint,
        });
        if (budget === null) break;
        elapsed += delay + budget;
      }
      expect(elapsed).toBeLessThanOrEqual(VISION_TOTAL_BUDGET_MS);
    }
  });
});

// A transient provider failure (503, rate limit, timeout) used to end the attachment: `extract` was
// called once and the catch below it degraded to the "couldn't extract" marker, permanently — no
// later turn can recover the content of that attachment (issue #319). These drive the real service
// through a fetch that personifies the vendor: Gemini's generateContent answering 503 then 200.

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
let keyId = 0n;

const CHATWOOT_INBOX_ID = 11;
const EXTRACTED = "recibo no valor de R$ 250,00";

// Gemini's generateContent shape, answering the given statuses in order (the last one repeats).
function geminiFetch(statuses: number[]) {
  const calls: number[] = [];
  const impl = (async () => {
    const status =
      statuses[calls.length] ?? statuses[statuses.length - 1] ?? 200;
    calls.push(status);
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { code: status } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: EXTRACTED }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// The budget has to reach the WIRE, on every endpoint shape: a provider that hardcodes its own
// deadline would leave the policy above deciding nothing, and three attempts of 60s would spend
// three minutes of a turn a customer is waiting on.
describe("the per-attempt budget is what aborts the call", () => {
  // Honors the abort signal, like a real fetch: resolves late, rejects the moment it is cut off.
  const slowFetch = (async (_url: string | URL, init?: RequestInit) => {
    return await new Promise<Response>((resolve, reject) => {
      const t = setTimeout(
        () => resolve(new Response("{}", { status: 200 })),
        5_000,
      );
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject((init.signal as AbortSignal).reason);
      });
    });
  }) as unknown as typeof fetch;

  for (const name of ["openai", "gemini", "anthropic"] as const) {
    test(`${name} stops at the budget it was handed`, async () => {
      const started = Date.now();
      const err = await getVisionProvider(name)
        ?.extract({
          bytes: new ArrayBuffer(4),
          mimeType: "image/png",
          kind: "image",
          prompt: "Descreva.",
          model: "m",
          apiKey: "k",
          baseURL: null,
          fetchImpl: slowFetch,
          timeoutMs: 40,
        })
        .then(() => null)
        .catch((e: unknown) => e);
      expect((err as Error)?.name).toBe("TimeoutError");
      // The point is the SHORT budget being honored: a hardcoded ceiling would wait far longer.
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  }
});

// The retry loop itself, driven with a stand-in provider — the only place the budget each attempt
// was HANDED is observable. The service picks its provider from the registry, so through that door
// the planned budget and the one the provider received cannot be told apart.
describe("extractWithRetry", () => {
  function recordingProvider(results: Array<"ok" | number>) {
    const budgets: number[] = [];
    let i = 0;
    return {
      budgets,
      provider: {
        defaultModel: "m",
        extract: async (req: VisionRequest) => {
          budgets.push(req.timeoutMs);
          const r = results[Math.min(i++, results.length - 1)] ?? "ok";
          if (r !== "ok") throw new VisionError("gemini", r);
          return { text: "ok", usage: null };
        },
      } as VisionProvider,
    };
  }

  const req = (kind: "image" | "document" = "image") => ({
    bytes: new ArrayBuffer(4),
    mimeType: kind === "image" ? "image/png" : "application/pdf",
    kind,
    prompt: "Descreva.",
    model: "m",
    apiKey: "k",
    baseURL: null,
    fetchImpl: fetch,
  });

  test("every attempt is handed the budget the policy planned, never the whole total", async () => {
    const { provider, budgets } = recordingProvider([503]);
    await expect(
      extractWithRetry({
        provider,
        providerName: "gemini",
        model: "m",
        req: req(),
        sleep: async () => {},
      }),
    ).rejects.toThrow("vision gemini failed with 503");
    expect(budgets).toHaveLength(VISION_MAX_ATTEMPTS);
    // The first is cut at the image ceiling so a second one can exist; the last is not, because
    // after it there is nothing to leave room for. Both are far below the 60s total a hardcoded
    // ceiling would have handed each of them.
    expect(budgets[0]).toBe(VISION_IMAGE_CEILING_MS);
    expect(budgets[1] as number).toBeGreaterThan(VISION_IMAGE_CEILING_MS);
    // `<=`, not `<`: the stand-in answers instantly and the wait is stubbed, so nothing of the
    // total is actually spent here and the remainder IS the total. That the remainder shrinks with
    // real elapsed time is the pure table's assertion, not this one's.
    expect(budgets[1] as number).toBeLessThanOrEqual(VISION_TOTAL_BUDGET_MS);
  });

  test("unmeasured work is handed the whole budget on the first attempt", async () => {
    // `now` frozen, not for speed but for exactness: with the real clock a millisecond passing
    // between `startedAt` and the budget makes this 59_999, and the assertion is about the ceiling
    // standing down, not about the machine.
    for (const r of [
      req("document"),
      { ...req(), baseURL: "https://vl.internal/v1" },
    ]) {
      const { provider, budgets } = recordingProvider(["ok"]);
      await extractWithRetry({
        provider,
        providerName: "gemini",
        model: "m",
        req: r,
        now: () => 0,
        sleep: async () => {},
      });
      expect(budgets).toEqual([VISION_TOTAL_BUDGET_MS]);
    }
  });

  test("it stops asking as soon as one attempt answers", async () => {
    const { provider, budgets } = recordingProvider([503, "ok"]);
    const out = await extractWithRetry({
      provider,
      providerName: "gemini",
      model: "m",
      req: req(),
      sleep: async () => {},
    });
    expect(out.text).toBe("ok");
    expect(budgets).toHaveLength(2);
  });

  test("a wait that oversleeps loses the attempt it was waiting for", async () => {
    // The budget is read AFTER the wait: a stalled or suspended process can sleep far past the
    // nominal delay, and an attempt planned before that wait would be handed time the total no
    // longer has. Here the clock jumps almost the whole budget while sleeping.
    const { provider, budgets } = recordingProvider([503]);
    let clock = 0;
    await expect(
      extractWithRetry({
        provider,
        providerName: "gemini",
        model: "m",
        req: req(),
        now: () => clock,
        sleep: async () => {
          clock += VISION_TOTAL_BUDGET_MS - 1_000;
        },
      }),
    ).rejects.toThrow("vision gemini failed with 503");
    expect(budgets).toHaveLength(1);
  });

  test("a wait is not spent when nothing is left for the attempt behind it", async () => {
    // The mirror of the case above, on the other side of the sleep: when a slow first attempt has
    // already spent the total, waiting out the backoff buys nothing, and the turn should not pay it
    // just to discover that.
    let clock = 0;
    const budgets: number[] = [];
    const waited: number[] = [];
    const provider = {
      defaultModel: "m",
      extract: async (r: VisionRequest) => {
        budgets.push(r.timeoutMs);
        clock += VISION_TOTAL_BUDGET_MS; // the call ran until the whole budget was gone
        throw new VisionError("gemini", 503);
      },
    } as VisionProvider;
    await expect(
      extractWithRetry({
        provider,
        providerName: "gemini",
        model: "m",
        req: req(),
        now: () => clock,
        sleep: async (ms) => {
          waited.push(ms);
        },
      }),
    ).rejects.toThrow("vision gemini failed with 503");
    expect(budgets).toHaveLength(1);
    expect(waited).toEqual([]);
  });

  test("it waits between attempts, and the waits are the policy's", async () => {
    const { provider } = recordingProvider([503, "ok"]);
    const waited: number[] = [];
    await extractWithRetry({
      provider,
      providerName: "gemini",
      model: "m",
      req: req(),
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    expect(waited).toHaveLength(VISION_MAX_ATTEMPTS - 1);
    expect(waited[0]).toBeGreaterThanOrEqual(
      VISION_RETRY_DELAYS_MS[0] as number,
    );
  });
});

function stubClient(meta: Array<Record<string, unknown>>) {
  const client = {
    downloadAttachment: async () => ({
      bytes: new ArrayBuffer(16),
      contentType: "image/png",
    }),
    updateAttachmentMeta: async (
      conversationId: number,
      messageId: number,
      attachmentId: number,
      m: Record<string, unknown>,
    ) => {
      meta.push({ conversationId, messageId, attachmentId, meta: m });
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

describe.skipIf(!dbUp)("vision retry", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "VISION", slug: `vision-retry-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 12,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "vision-key", secret: encryptJson("sk-vision") },
      select: { id: true },
    });
    keyId = key.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        settings: {
          vision: {
            enabled: true,
            provider: "gemini",
            credentialRef: `vault:${keyId}`,
          },
        },
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "Suporte",
        agentId: agent.id,
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "inboxes",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function cfg(): Promise<VisionConfig> {
    return (await resolveVisionConfig(
      tenantId,
      instanceId,
      CHATWOOT_INBOX_ID,
      appDb,
    )) as VisionConfig;
  }

  test("a 503 followed by a 200 still extracts, and the text reaches Chatwoot", async () => {
    const { impl, calls } = geminiFetch([503, 200]);
    const meta: Array<Record<string, unknown>> = [];
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 700,
      messageId: 40,
      attachmentId: 3,
      dataUrl: "https://chat.example.com/recibo.png",
      cfg: await cfg(),
      base: appDb,
      deps: {
        makeClient: stubClient(meta),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(calls).toEqual([503, 200]);
    expect(out?.text).toBe(EXTRACTED);
    expect(meta).toEqual([
      {
        conversationId: 700,
        messageId: 40,
        attachmentId: 3,
        meta: { image_description: EXTRACTED },
      },
    ]);
  });

  test("a 401 is permanent: one call, and the attachment stays unextracted", async () => {
    const { impl, calls } = geminiFetch([401]);
    const meta: Array<Record<string, unknown>> = [];
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 701,
      messageId: 41,
      attachmentId: 4,
      dataUrl: "https://chat.example.com/recibo.png",
      cfg: await cfg(),
      base: appDb,
      deps: {
        makeClient: stubClient(meta),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(calls).toEqual([401]);
    expect(out).toBeNull();
    expect(meta).toEqual([]);
  });

  test("each attempt leaves its own line, carrying what it was allowed to spend", async () => {
    const { impl } = geminiFetch([503]);
    const turnId = `vision-retry-${process.pid}`;
    await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 703,
      messageId: 43,
      attachmentId: 6,
      dataUrl: "https://chat.example.com/recibo.png",
      cfg: await cfg(),
      base: appDb,
      flow: { tenantId, turnId, source: "inbox", base: appDb },
      deps: {
        makeClient: stubClient([]),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    // emit is fire-and-forget → poll until every line lands.
    let rows: Array<{ detail: unknown }> = [];
    for (let i = 0; i < 100 && rows.length < VISION_MAX_ATTEMPTS; i++) {
      rows = await suDb.executionLog.findMany({
        where: { tenantId, turnId, stage: "vision" },
        select: { detail: true },
        orderBy: { id: "asc" },
      });
      if (rows.length < VISION_MAX_ATTEMPTS)
        await new Promise((r) => setTimeout(r, 20));
    }
    // Sorted BY `attempt`, not taken in row order: `emitFlowEvent` is fire-and-forget, so the lines
    // of one turn race each other to the table and their ids do not carry the order (measured —
    // three lines landed 1, 3, 2). `attempt` carries it, which is the whole reason it is on the
    // line, and every positional assertion below reads this ordering rather than the table's.
    const details = rows
      .map((r) => r.detail as Record<string, unknown>)
      .sort((a, b) => (a.attempt as number) - (b.attempt as number));
    expect(details.map((d) => d.attempt)).toEqual([1, 2]);
    // The two lines do NOT carry the same budget: the last attempt is capped by what is left of the
    // total rather than by the kind's ceiling.
    expect(details[0]?.budgetMs).toBe(VISION_IMAGE_CEILING_MS);
    expect(details[1]?.budgetMs as number).toBeGreaterThan(
      VISION_IMAGE_CEILING_MS,
    );
  });

  test("a provider that is down for every attempt gives up bounded, not forever", async () => {
    const { impl, calls } = geminiFetch([503]);
    const meta: Array<Record<string, unknown>> = [];
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 702,
      messageId: 42,
      attachmentId: 5,
      dataUrl: "https://chat.example.com/recibo.png",
      cfg: await cfg(),
      base: appDb,
      deps: {
        makeClient: stubClient(meta),
        fetchImpl: impl,
        sleep: async () => {},
      },
    });
    expect(calls.length).toBe(VISION_MAX_ATTEMPTS);
    expect(out).toBeNull();
    expect(meta).toEqual([]);
  });
});
