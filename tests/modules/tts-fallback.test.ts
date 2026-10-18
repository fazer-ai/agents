import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { providerFailure } from "@/lib/provider-failure";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import type { FlowContext } from "@/modules/flowlog/service";
import type { TtsCheckConfig } from "@/modules/tts/check";
import { getTtsProvider, type TtsProvider } from "@/modules/tts/providers";
import { synthesizeReply } from "@/modules/tts/service";
import {
  readTtsConfig,
  TTS_DEFAULTS,
  type TtsConfig,
} from "@/modules/tts/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// The TTS timeout and the fallback voice: how long one synthesis may take, and which failures get a
// second voice before the reply goes as text. The provider is a fake `fetch` that answers per model
// (OpenAI-shaped, so the model is in the JSON body), and a timeout is the error `fetch` raises when
// its signal fires, so no case waits for a real clock.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let primaryKey = "";
let otherKey = "";

type Answer = "ok" | "timeout" | number;

// What the provider is asked, per request, and what each model answers: one answer for every
// request, or a list consumed in order (its last entry repeating).
function provider(answers: Record<string, Answer | Answer[]>) {
  const calls: Array<{ url: string; model: string; key: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers as HeadersInit);
    const body = JSON.parse(String(init.body)) as { model?: string };
    const model = body.model ?? "";
    calls.push({
      url,
      model,
      key: headers.get("authorization") ?? headers.get("xi-api-key"),
    });
    const scripted = answers[model] ?? "ok";
    const seen = calls.filter((c) => c.model === model).length - 1;
    const a = Array.isArray(scripted)
      ? scripted[Math.min(seen, scripted.length - 1)]
      : scripted;
    if (a === "timeout") {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    if (a !== "ok") return new Response("{}", { status: a });
    return new Response(new Uint8Array([calls.length]).buffer, {
      status: 200,
      headers: { "content-type": "audio/ogg" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const cfgOf = (over: Partial<TtsConfig> = {}): TtsConfig => ({
  ...TTS_DEFAULTS,
  mode: "mirror",
  provider: "openai",
  model: "gpt-4o-mini-tts",
  credentialRef: primaryKey,
  normalize: false,
  ...over,
});

const OFF: TtsCheckConfig = { url: "", mode: "off", token: "", timeoutMs: 0 };

let turn = 0;
const flowOf = (): FlowContext => ({
  tenantId,
  turnId: `tts-fallback-${process.pid}-${++turn}`,
  source: "inbox",
  base: appDb,
});

// The turn's `tts` lines, primary first: written fire-and-forget, so read in the order they mean.
async function ttsLines(f: FlowContext) {
  const rows = await flowLogRows(suDb, {
    where: { tenantId, turnId: f.turnId, stage: "tts" },
  });
  const fallback = (r: (typeof rows)[number]) =>
    (r.detail as Record<string, unknown>).fallback === true ? 1 : 0;
  return rows
    .sort((a, b) => fallback(a) - fallback(b))
    .map((r) => ({
      status: r.status,
      level: r.level,
      provider: r.provider,
      model: r.model,
      fallback: (r.detail as Record<string, unknown>).fallback ?? null,
      reason: (r.detail as Record<string, unknown>).reason ?? null,
    }));
}

const run = (
  cfg: TtsConfig,
  fetchImpl: typeof fetch,
  flow?: FlowContext,
  extra: { check?: TtsCheckConfig; checkFetchImpl?: typeof fetch } = {},
) =>
  synthesizeReply({
    tenantId,
    cfg,
    text: "Claro, MARCADOR-PII-1517, posso ajudar.",
    base: appDb,
    deps: { fetchImpl, checkFetchImpl: extra.checkFetchImpl },
    check: extra.check ?? OFF,
    flow,
  });

describe("reading the timeout and the fallback voice", () => {
  test("the timeout is read clamped, and absent is the default", () => {
    const read = (timeoutMs: unknown) =>
      readTtsConfig({ tts: { timeoutMs } }).timeoutMs;
    expect([read(15_000), read(10), read(900_000), read(undefined)]).toEqual([
      15_000,
      1_000,
      120_000,
      null,
    ]);
  });

  // REST stores the bag as sent, so a value outside the band is refused at the write instead of
  // being stored and shown while synthesis runs at the clamped one.
  test("a write outside the band is refused, on REST and MCP alike", () => {
    const ok = (timeoutMs: unknown) =>
      BEHAVIOR_PATCH_SHAPE.tts.safeParse({ timeoutMs }).success;
    expect([ok(0), ok(-5000), ok(999), ok(120_001), ok(1e12)]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect([ok(1000), ok(15_000), ok(120_000), ok(null)]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  // Anything else would retry the provider that just failed.
  test("an unknown fallback provider is no fallback at all", () => {
    expect(
      readTtsConfig({ tts: { fallbackProvider: "azure" } }).fallbackProvider,
    ).toBeNull();
    expect(
      readTtsConfig({ tts: { fallbackProvider: "elevenlabs" } })
        .fallbackProvider,
    ).toBe("elevenlabs");
  });
});

// A slow provider sends its headers and then streams the audio, so the deadline usually fires while
// the BODY is read, where the runtime reports a read error that names no timeout.
describe("the deadline covers the body", () => {
  test("an abort while the audio streams is reported as a timeout", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          signal.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;
    const err = await (getTtsProvider("openai") as TtsProvider)
      .synthesize({
        text: "oi",
        voice: "alloy",
        model: "gpt-4o-mini-tts",
        language: "",
        apiKey: "sk",
        baseURL: null,
        fetchImpl,
        format: "ogg_opus",
        timeoutMs: 20,
      })
      .catch((e: unknown) => e);
    expect(providerFailure(err)).toBe("timeout");
  });

  // The status arrived before the deadline; only the optional error code was still being read.
  test("a 401 whose error body stalls stays a 401, never a timeout", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          signal.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 401 });
    }) as unknown as typeof fetch;
    const err = await (getTtsProvider("openai") as TtsProvider)
      .synthesize({
        text: "oi",
        voice: "alloy",
        model: "gpt-4o-mini-tts",
        language: "",
        apiKey: "sk",
        baseURL: null,
        fetchImpl,
        format: "ogg_opus",
        timeoutMs: 20,
      })
      .catch((e: unknown) => e);
    expect(providerFailure(err)).toBe("HTTP 401");
  });
});

describe.skipIf(!dbUp)("tts timeout and fallback voice", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TTS fallback", slug: `tts-fallback-${process.pid}` },
    });
    tenantId = t.id;
    const a = await suDb.vaultEntry.create({
      data: { tenantId, name: "tts-main", secret: encryptJson("sk-main") },
      select: { id: true },
    });
    const b = await suDb.vaultEntry.create({
      data: { tenantId, name: "tts-other", secret: encryptJson("sk-other") },
      select: { id: true },
    });
    primaryKey = `vault:${a.id}`;
    otherKey = `vault:${b.id}`;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.vaultEntry.deleteMany({ where: { tenantId } });
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  describe("the timeout", () => {
    const timeouts: number[] = [];
    let spy: ReturnType<typeof spyOn> | null = null;
    const watch = () => {
      timeouts.length = 0;
      const real = AbortSignal.timeout.bind(AbortSignal);
      spy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
        timeouts.push(ms);
        return real(ms);
      });
    };
    afterEach(() => {
      spy?.mockRestore();
      spy = null;
    });

    test("the agent's timeout is the one the request is sent with", async () => {
      const p = provider({});
      watch();
      await run(cfgOf({ timeoutMs: 15_000 }), p.fetchImpl);
      expect(timeouts).toEqual([15_000]);
    });

    test("an agent that never set one waits the 60 s it always did", async () => {
      const p = provider({});
      watch();
      await run(cfgOf(), p.fetchImpl);
      expect(timeouts).toEqual([60_000]);
    });
  });

  test("a primary that times out is answered by the fallback, on the primary's key", async () => {
    const p = provider({ "gpt-4o-mini-tts": "timeout" });
    const f = flowOf();
    const out = await run(
      cfgOf({ fallbackProvider: "openai", fallbackModel: "tts-1" }),
      p.fetchImpl,
      f,
    );
    expect(new Uint8Array(out?.audio as ArrayBuffer)[0]).toBe(2);
    expect(p.calls.map((c) => [c.model, c.key])).toEqual([
      ["gpt-4o-mini-tts", "Bearer sk-main"],
      ["tts-1", "Bearer sk-main"],
    ]);
    expect(await ttsLines(f)).toEqual([
      {
        status: "error",
        level: "warn",
        provider: "openai",
        model: "gpt-4o-mini-tts",
        fallback: null,
        reason: null,
      },
      {
        status: "ok",
        level: "info",
        provider: "openai",
        model: "tts-1",
        fallback: true,
        reason: null,
      },
    ]);
  });

  test("a transient status (503) also goes to the fallback", async () => {
    const p = provider({ "gpt-4o-mini-tts": 503 });
    const out = await run(
      cfgOf({ fallbackProvider: "openai", fallbackModel: "tts-1" }),
      p.fetchImpl,
    );
    expect(out).not.toBeNull();
    expect(p.calls.map((c) => c.model)).toEqual(["gpt-4o-mini-tts", "tts-1"]);
  });

  // A dead key or a bad request is the operator's to fix, and a fallback answering would hide it.
  test("a 401 goes straight to text, the fallback never asked", async () => {
    const p = provider({ "gpt-4o-mini-tts": 401 });
    await expect(
      run(
        cfgOf({ fallbackProvider: "openai", fallbackModel: "tts-1" }),
        p.fetchImpl,
      ),
    ).rejects.toThrow(/401/);
    expect(p.calls.map((c) => c.model)).toEqual(["gpt-4o-mini-tts"]);
  });

  test("when the fallback fails too, it was asked once and the reply goes as text", async () => {
    const p = provider({ "gpt-4o-mini-tts": "timeout", "tts-1": 503 });
    const f = flowOf();
    await expect(
      run(
        cfgOf({ fallbackProvider: "openai", fallbackModel: "tts-1" }),
        p.fetchImpl,
        f,
      ),
    ).rejects.toThrow();
    expect(p.calls.map((c) => c.model)).toEqual(["gpt-4o-mini-tts", "tts-1"]);
    expect((await ttsLines(f)).map((l) => [l.status, l.fallback])).toEqual([
      ["error", null],
      ["error", true],
    ]);
  });

  test("a fallback on another provider with no key of its own is skipped, visibly, and never asked", async () => {
    const p = provider({ "gpt-4o-mini-tts": "timeout" });
    const f = flowOf();
    await expect(
      run(
        cfgOf({ fallbackProvider: "openrouter", fallbackModel: "kokoro" }),
        p.fetchImpl,
        f,
      ),
    ).rejects.toThrow(/timed out/);
    expect(p.calls).toHaveLength(1);
    expect(await ttsLines(f)).toEqual([
      expect.objectContaining({ status: "error", fallback: null }),
      expect.objectContaining({
        status: "skipped",
        level: "warn",
        provider: "openrouter",
        fallback: true,
        reason: "no_credential",
      }),
    ]);
  });

  test("a fallback on another provider runs on its own key and endpoint, never the primary's", async () => {
    const p = provider({ "gpt-4o-mini-tts": "timeout" });
    await run(
      cfgOf({
        baseURL: "https://tts-proxy.example.com/v1",
        fallbackProvider: "openrouter",
        fallbackModel: "hexgrad/kokoro-82m",
        fallbackCredentialRef: otherKey,
      }),
      p.fetchImpl,
    );
    expect(p.calls.map((c) => [c.url, c.key])).toEqual([
      ["https://tts-proxy.example.com/v1/audio/speech", "Bearer sk-main"],
      ["https://openrouter.ai/api/v1/audio/speech", "Bearer sk-other"],
    ]);
  });

  // The audio check asks for another synthesis of a corrupted audio: it repeats the voice that
  // produced it, and the primary that already failed is not asked again.
  test("a regeneration after the audio check stays on the fallback voice", async () => {
    const p = provider({ "gpt-4o-mini-tts": "timeout" });
    let asked = 0;
    const detector = (async () =>
      Response.json(
        asked++ === 0
          ? { corrupted: true, score: 0.9, verdict: "balbucio" }
          : { corrupted: false, score: 0.01, verdict: "ok" },
      )) as unknown as typeof fetch;
    const out = await run(
      cfgOf({ fallbackProvider: "openai", fallbackModel: "tts-1" }),
      p.fetchImpl,
      undefined,
      {
        check: {
          url: "http://detector.test",
          mode: "enforce",
          token: "",
          timeoutMs: 2_000,
        },
        checkFetchImpl: detector,
      },
    );
    expect(out).not.toBeNull();
    expect(p.calls.map((c) => c.model)).toEqual([
      "gpt-4o-mini-tts",
      "tts-1",
      "tts-1",
    ]);
  });

  test("the fallback is tried once per reply: a regeneration it fails goes to text", async () => {
    const p = provider({ "gpt-4o-mini-tts": "timeout", "tts-1": ["ok", 503] });
    const detector = (async () =>
      Response.json({
        corrupted: true,
        score: 0.9,
        verdict: "balbucio",
      })) as unknown as typeof fetch;
    await expect(
      run(
        cfgOf({ fallbackProvider: "openai", fallbackModel: "tts-1" }),
        p.fetchImpl,
        undefined,
        {
          check: {
            url: "http://detector.test",
            mode: "enforce",
            token: "",
            timeoutMs: 2_000,
          },
          checkFetchImpl: detector,
        },
      ),
    ).rejects.toThrow(/503/);
    expect(p.calls.map((c) => c.model)).toEqual([
      "gpt-4o-mini-tts",
      "tts-1",
      "tts-1",
    ]);
  });

  // A turn called off while the primary was pending pays for no second synthesis.
  test("a turn called off before the fallback starts never asks it", async () => {
    const p = provider({ "gpt-4o-mini-tts": "timeout" });
    await expect(
      synthesizeReply({
        tenantId,
        cfg: cfgOf({ fallbackProvider: "openai", fallbackModel: "tts-1" }),
        text: "Claro, posso ajudar.",
        base: appDb,
        deps: { fetchImpl: p.fetchImpl },
        check: OFF,
        shouldStop: async () => true,
      }),
    ).rejects.toThrow(/timed out/);
    expect(p.calls.map((c) => c.model)).toEqual(["gpt-4o-mini-tts"]);
  });
});
