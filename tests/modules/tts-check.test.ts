import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { parseTtsCheckMode } from "@/config";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import type { FlowContext } from "@/modules/flowlog/service";
import {
  checkSynthesizedAudio,
  parseVerdict,
  type TtsCheckConfig,
  TtsCheckError,
} from "@/modules/tts/check";
import { synthesizeReply } from "@/modules/tts/service";
import { TTS_DEFAULTS, type TtsConfig } from "@/modules/tts/settings";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// The corrupted-audio check (issue #779). The detector is faked at its HTTP boundary, apart from the
// TTS provider, so each case counts syntheses and checks independently: the claims are about how
// many times each one was paid for, and in which order.

const CHECK: TtsCheckConfig = {
  url: "http://detector.test",
  mode: "enforce",
  token: "",
  timeoutMs: 2_000,
};

// A provider that answers every synthesis with DIFFERENT bytes (the call number), so a test can
// tell which synthesis the caller was handed.
function countingProvider() {
  const rec = { calls: 0 };
  const fetchImpl = (async () => {
    rec.calls++;
    return new Response(new Uint8Array([rec.calls, 0, 0, 0]).buffer, {
      status: 200,
      headers: { "content-type": "audio/ogg" },
    });
  }) as unknown as typeof fetch;
  return { rec, fetchImpl };
}

// A detector that answers each call from a script; past the end it repeats the last answer.
function scriptedDetector(answers: Array<Record<string, unknown> | "down">) {
  const rec = {
    calls: 0,
    forms: [] as FormData[],
    urls: [] as string[],
    auth: [] as Array<string | null>,
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    rec.urls.push(url);
    rec.forms.push(init.body as FormData);
    rec.auth.push(
      new Headers(init.headers as HeadersInit).get("authorization"),
    );
    const a = answers[Math.min(rec.calls, answers.length - 1)];
    rec.calls++;
    if (a === "down") throw new TypeError("fetch failed: connection refused");
    return Response.json(a);
  }) as unknown as typeof fetch;
  return { rec, fetchImpl };
}

const CORRUPTED = { corrupted: true, score: 0.97, verdict: "balbucio" };
const CLEAN = { corrupted: false, score: 0.02, verdict: "ok" };

describe("TTS_CHECK_MODE", () => {
  test("a detector URL with no mode means shadow, never enforce", () => {
    expect(parseTtsCheckMode(undefined, "http://d")).toBe("shadow");
    expect(parseTtsCheckMode("  ", "http://d")).toBe("shadow");
  });
  test("no URL and no mode means off", () => {
    expect(parseTtsCheckMode(undefined, "")).toBe("off");
  });
  test("a mode that needs a detector refuses to boot without one", () => {
    expect(() => parseTtsCheckMode("enforce", "")).toThrow(/TTS_CHECK_URL/);
    expect(() => parseTtsCheckMode("shadow", "")).toThrow(/TTS_CHECK_URL/);
  });
  test("an unknown mode refuses to boot", () => {
    expect(() => parseTtsCheckMode("block", "http://d")).toThrow(
      /TTS_CHECK_MODE/,
    );
  });
  test("the mode is case-insensitive and off is always accepted", () => {
    expect(parseTtsCheckMode("ENFORCE", "http://d")).toBe("enforce");
    expect(parseTtsCheckMode("off", "")).toBe("off");
  });
});

describe("the detector's answer", () => {
  test("without a boolean `corrupted` it is unreadable, not clean", () => {
    for (const body of [
      {},
      { corrupted: "false" },
      { corrupted: 0 },
      null,
      "ok",
    ]) {
      expect(() => parseVerdict(body)).toThrow(TtsCheckError);
    }
  });
  test("a score out of range and a verdict outside the vocabulary degrade to null", () => {
    expect(
      parseVerdict({ corrupted: true, score: 1.5, verdict: "tem texto aqui" }),
    ).toEqual({ corrupted: true, score: null, verdict: null });
    // Slug-shaped customer data: a pattern would admit both, the vocabulary admits neither.
    for (const verdict of ["5511999998888", "maria_silva"]) {
      expect(parseVerdict({ corrupted: true, verdict }).verdict).toBeNull();
    }
    expect(parseVerdict({ corrupted: true, verdict: "zumbido" }).verdict).toBe(
      "zumbido",
    );
    expect(parseVerdict({ corrupted: false, score: 0 })).toEqual({
      corrupted: false,
      score: 0,
      verdict: null,
    });
  });
  test("the request carries the audio, both texts and the bearer token", async () => {
    const d = scriptedDetector([CLEAN]);
    await checkSynthesizedAudio({
      cfg: { ...CHECK, token: "tok" },
      audio: new Uint8Array([1, 2, 3]).buffer,
      mime: "audio/ogg",
      fileName: "reply.ogg",
      text: "R$ 15",
      speech: "quinze reais",
      fetchImpl: d.fetchImpl,
    });
    expect(d.rec.urls).toEqual(["http://detector.test/v1/check"]);
    expect(d.rec.auth).toEqual(["Bearer tok"]);
    const form = d.rec.forms[0] as FormData;
    expect(form.get("text")).toBe("R$ 15");
    expect(form.get("speech")).toBe("quinze reais");
    const audio = form.get("audio") as File;
    expect(audio.name).toBe("reply.ogg");
    expect(audio.size).toBe(3);
  });
  test("each way of failing has its own closed code", async () => {
    const cases: Array<[typeof fetch, string]> = [
      [
        (async () =>
          new Response("boom", { status: 500 })) as unknown as typeof fetch,
        "http_status",
      ],
      [
        (async () =>
          new Response("<html>", { status: 200 })) as unknown as typeof fetch,
        "malformed",
      ],
      [
        (async () => {
          throw new TypeError("refused");
        }) as unknown as typeof fetch,
        "network",
      ],
      [
        ((_u: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          })) as unknown as typeof fetch,
        "timeout",
      ],
      // Headers in time, then the body stalls until the deadline: a timeout, not `malformed`.
      [
        (async (_u: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener("abort", () =>
                  controller.error(init.signal?.reason),
                );
              },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
        "timeout",
      ],
      // Headers in time, then the connection drops mid-body: a network failure.
      [
        (async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"corr'));
                controller.error(new TypeError("socket closed"));
              },
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
        "network",
      ],
    ];
    for (const [fetchImpl, code] of cases) {
      const err = await checkSynthesizedAudio({
        cfg: { ...CHECK, timeoutMs: 50 },
        audio: new ArrayBuffer(4),
        mime: "audio/ogg",
        fileName: "reply.ogg",
        text: "a",
        speech: "a",
        fetchImpl,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(TtsCheckError);
      expect((err as TtsCheckError).code).toBe(code as TtsCheckError["code"]);
    }
  });
});

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
let contactId = 0n;
let ttsKeyId = 0n;

// Words that must never reach the execution log: the reply, and a field the detector sends that
// the agents side has no business reading.
const REPLY = "Claro, MARCADOR-RESPOSTA-779, vou te ajudar!";
const DETECTOR_EXTRA = "MARCADOR-DETECTOR-779";

const cfgOf = (normalize = false): TtsConfig => ({
  ...TTS_DEFAULTS,
  mode: "mirror",
  provider: "openai",
  model: "",
  voice: "",
  credentialRef: `vault:${ttsKeyId}`,
  baseURL: null,
  normalize,
});

let turn = 0;
const flowOf = (): FlowContext => ({
  tenantId,
  turnId: `tts-check-${process.pid}-${++turn}`,
  source: "inbox",
  base: appDb,
});

// In attempt order, not id order: the lines are written fire-and-forget, so two of them emitted a
// few milliseconds apart can land in either order.
async function checkLines(f: FlowContext) {
  const rows = await flowLogRows(suDb, {
    where: { tenantId, turnId: f.turnId, stage: "tts_check" },
  });
  const attempt = (r: (typeof rows)[number]) =>
    Number((r.detail as Record<string, unknown>).attempt);
  return rows.sort((a, b) => attempt(a) - attempt(b));
}

describe.skipIf(!dbUp)("tts audio check", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TTS check", slug: `tts-check-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-llm") },
      select: { id: true },
    });
    const ttsKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "tts-key", secret: encryptJson("sk-tts") },
      select: { id: true },
    });
    ttsKeyId = ttsKey.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          tts: {
            mode: "mirror",
            provider: "openai",
            credentialRef: `vault:${ttsKeyId}`,
            normalize: false,
          },
          split: { enabled: false },
        },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `tts-check-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instanceId,
        tenantId,
        name: "Cliente",
        chatwootContactId: 1,
      },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "llm_usage",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "contacts",
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

  // Issue #802: the agent picks the mode, the deployment owns the detector. `check` here stands for
  // the deployment (`config.ttsCheck`), and `cfg.checkMode` for the agent's own choice.
  describe("the agent's own mode", () => {
    const run = async (
      agent: TtsConfig["checkMode"],
      deployment: TtsCheckConfig,
      answers: Array<Record<string, unknown> | "down"> = [CORRUPTED],
    ) => {
      const p = countingProvider();
      const d = scriptedDetector(answers);
      const out = await synthesizeReply({
        tenantId,
        cfg: { ...cfgOf(), checkMode: agent },
        text: REPLY,
        base: appDb,
        deps: { fetchImpl: p.fetchImpl, checkFetchImpl: d.fetchImpl },
        check: deployment,
      });
      return { out, syntheses: p.rec.calls, checks: d.rec.calls };
    };

    test("regenerate on an agent overrides a deployment that is off", async () => {
      const r = await run("enforce", { ...CHECK, mode: "off" });
      expect(r.out).toBeNull();
      expect(r.syntheses).toBe(3);
      expect(r.checks).toBe(3);
    });

    test("off on an agent overrides a deployment that regenerates", async () => {
      const r = await run("off", { ...CHECK, mode: "enforce" });
      expect(r.out).not.toBeNull();
      expect(r.checks).toBe(0);
    });

    test("an agent that never chose follows the deployment", async () => {
      const r = await run(null, { ...CHECK, mode: "enforce" }, [CLEAN]);
      expect(r.out).not.toBeNull();
      expect(r.checks).toBe(1);
      expect((await run(null, { ...CHECK, mode: "off" })).checks).toBe(0);
    });

    test("with no detector, the agent's choice calls nothing and the audio goes out", async () => {
      const r = await run("enforce", { ...CHECK, url: "", mode: "off" });
      expect(r.out).not.toBeNull();
      expect(r.syntheses).toBe(1);
      expect(r.checks).toBe(0);
    });
  });

  test("off: the detector is never called", async () => {
    const p = countingProvider();
    const d = scriptedDetector([CORRUPTED]);
    const out = await synthesizeReply({
      tenantId,
      cfg: cfgOf(),
      text: REPLY,
      base: appDb,
      deps: { fetchImpl: p.fetchImpl, checkFetchImpl: d.fetchImpl },
      check: { ...CHECK, mode: "off" },
    });
    expect(out).not.toBeNull();
    expect(p.rec.calls).toBe(1);
    expect(d.rec.calls).toBe(0);
  });

  test("shadow: the audio is returned before the detector answers, and only a line changes", async () => {
    const p = countingProvider();
    let release: (v: Response) => void = () => {};
    let asked = 0;
    const slow = (async () => {
      asked++;
      return new Promise<Response>((r) => {
        release = r;
      });
    }) as unknown as typeof fetch;
    const f = flowOf();
    const out = await synthesizeReply({
      tenantId,
      cfg: cfgOf(),
      text: REPLY,
      base: appDb,
      deps: { fetchImpl: p.fetchImpl, checkFetchImpl: slow },
      check: { ...CHECK, mode: "shadow" },
      flow: f,
    });
    // Returned while the detector is still holding its answer.
    expect(new Uint8Array(out?.audio as ArrayBuffer)[0]).toBe(1);
    expect(asked).toBe(1);
    release(Response.json(CORRUPTED));
    const lines = await checkLines(f);
    expect(p.rec.calls).toBe(1);
    expect(lines.map((l) => [l.level, l.detail])).toEqual([
      [
        "warn",
        {
          mode: "shadow",
          attempt: 1,
          outcome: "flagged",
          corrupted: true,
          score: 0.97,
          verdict: "balbucio",
        },
      ],
    ]);
  });

  test("enforce, always corrupted: 3 syntheses, 3 checks, one rewrite, and no audio", async () => {
    const p = countingProvider();
    const d = scriptedDetector([CORRUPTED]);
    let rewrites = 0;
    const f = flowOf();
    const out = await synthesizeReply({
      tenantId,
      cfg: cfgOf(true),
      text: REPLY,
      base: appDb,
      deps: {
        fetchImpl: p.fetchImpl,
        checkFetchImpl: d.fetchImpl,
        normalizeSpeech: async (t) => {
          rewrites++;
          return t;
        },
      },
      check: CHECK,
      flow: f,
    });
    expect(out).toBeNull();
    expect(p.rec.calls).toBe(3);
    expect(d.rec.calls).toBe(3);
    expect(rewrites).toBe(1);
    const lines = await checkLines(f);
    expect(
      lines.map((l) => {
        const d = l.detail as Record<string, unknown>;
        return [d.attempt, d.outcome];
      }),
    ).toEqual([
      [1, "regenerated"],
      [2, "regenerated"],
      [3, "rejected"],
    ]);
    // Each synthesis line says which attempt it was.
    const synths = await flowLogRows(suDb, {
      where: { tenantId, turnId: f.turnId, stage: "tts" },
    });
    // NOTE: sorted, because the lines are written fire-and-forget and land in whatever order the
    // writes finish; the claim is which attempts exist, not which row got the lower id.
    expect(
      synths
        .map((l) => Number((l.detail as Record<string, unknown>).attempt))
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  test("enforce, corrupted then clean: the caller gets the SECOND synthesis", async () => {
    const p = countingProvider();
    const d = scriptedDetector([CORRUPTED, CLEAN]);
    const f = flowOf();
    const out = await synthesizeReply({
      tenantId,
      cfg: cfgOf(),
      text: REPLY,
      base: appDb,
      deps: { fetchImpl: p.fetchImpl, checkFetchImpl: d.fetchImpl },
      check: CHECK,
      flow: f,
    });
    expect(new Uint8Array(out?.audio as ArrayBuffer)[0]).toBe(2);
    expect(p.rec.calls).toBe(2);
    // The audio the detector judged clean is the one handed back.
    const judged = d.rec.forms[1]?.get("audio") as File;
    expect(new Uint8Array(await judged.arrayBuffer())[0]).toBe(2);
    const lines = await checkLines(f);
    expect(
      lines.map((l) => [
        l.level,
        (l.detail as Record<string, unknown>).outcome,
      ]),
    ).toEqual([
      ["warn", "regenerated"],
      ["info", "passed"],
    ]);
  });

  test("enforce, clean at once: no regeneration", async () => {
    const p = countingProvider();
    const d = scriptedDetector([CLEAN]);
    const out = await synthesizeReply({
      tenantId,
      cfg: cfgOf(),
      text: REPLY,
      base: appDb,
      deps: { fetchImpl: p.fetchImpl, checkFetchImpl: d.fetchImpl },
      check: CHECK,
    });
    expect(new Uint8Array(out?.audio as ArrayBuffer)[0]).toBe(1);
    expect(p.rec.calls).toBe(1);
    expect(d.rec.calls).toBe(1);
  });

  test("enforce, detector down: the audio goes out unchecked, with a line saying so", async () => {
    const p = countingProvider();
    const d = scriptedDetector(["down"]);
    const f = flowOf();
    const out = await synthesizeReply({
      tenantId,
      cfg: cfgOf(),
      text: REPLY,
      base: appDb,
      deps: { fetchImpl: p.fetchImpl, checkFetchImpl: d.fetchImpl },
      check: CHECK,
      flow: f,
    });
    expect(new Uint8Array(out?.audio as ArrayBuffer)[0]).toBe(1);
    expect(p.rec.calls).toBe(1);
    const lines = await checkLines(f);
    expect(lines.map((l) => [l.level, l.status, l.detail])).toEqual([
      [
        "warn",
        "error",
        {
          mode: "enforce",
          attempt: 1,
          outcome: "unavailable",
          reason: "network",
        },
      ],
    ]);
  });

  test("enforce, turn called off after a corrupted verdict: no regeneration, no audio, and the line says so", async () => {
    const p = countingProvider();
    const d = scriptedDetector([CORRUPTED]);
    const f = flowOf();
    const out = await synthesizeReply({
      tenantId,
      cfg: cfgOf(),
      text: REPLY,
      base: appDb,
      deps: { fetchImpl: p.fetchImpl, checkFetchImpl: d.fetchImpl },
      check: CHECK,
      shouldStop: async () => true,
      flow: f,
    });
    expect(out).toBeNull();
    expect(p.rec.calls).toBe(1);
    expect(d.rec.calls).toBe(1);
    // Not `regenerated`: no second synthesis ran.
    const lines = await checkLines(f);
    expect(
      lines.map((l) => (l.detail as Record<string, unknown>).outcome),
    ).toEqual(["called_off"]);
  });

  test("enforce, a regeneration whose synthesis fails throws, which the caller turns into text", async () => {
    let calls = 0;
    const failsSecond = (async () => {
      calls++;
      if (calls > 1) return new Response("{}", { status: 500 });
      return new Response(new ArrayBuffer(4), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      });
    }) as unknown as typeof fetch;
    const d = scriptedDetector([CORRUPTED]);
    const err = await synthesizeReply({
      tenantId,
      cfg: cfgOf(),
      text: REPLY,
      base: appDb,
      deps: { fetchImpl: failsSecond, checkFetchImpl: d.fetchImpl },
      check: CHECK,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toBe(2);
  });

  test("no words from the reply or the detector reach the execution log", async () => {
    const p = countingProvider();
    const d = scriptedDetector([
      {
        ...CORRUPTED,
        trechos: [{ texto: DETECTOR_EXTRA }],
        note: DETECTOR_EXTRA,
      },
      "down",
    ]);
    const f = flowOf();
    await synthesizeReply({
      tenantId,
      cfg: cfgOf(),
      text: REPLY,
      base: appDb,
      deps: { fetchImpl: p.fetchImpl, checkFetchImpl: d.fetchImpl },
      check: CHECK,
      flow: f,
    });
    const rows = await flowLogRows(suDb, {
      where: { tenantId, turnId: f.turnId },
    });
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify(rows.map((r) => [r.detail, r.errorMessage]));
    expect(dump).not.toContain("MARCADOR-RESPOSTA-779");
    expect(dump).not.toContain(DETECTOR_EXTRA);
  });

  // The customer-visible end of the two modes, through the runtime.
  const audioEvent = (convId: number): NormalizedChatwootEvent => ({
    event: "message_created",
    conversationId: convId,
    contactInboxId: null,
    inboxId: 7,
    status: "pending",
    assigneeType: null,
    assigneeId: null,
    assigneeName: null,
    message: {
      id: 1,
      content: "",
      messageType: "incoming",
      private: false,
      attachments: [{ id: 5, fileType: "audio", dataUrl: "https://x/a.ogg" }],
      transcribedText: "quero agendar",
    },
  });

  async function turnWith(
    convId: number,
    check: TtsCheckConfig,
    detector: typeof fetch,
  ) {
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "pending",
        assigneeType: null,
        contactId,
        threadId: `${tenantId}:${instanceId}:${convId}`,
        lastEventAt: new Date(),
      },
    });
    const sent = { text: [] as string[], audio: 0 };
    const client = {
      sendMessage: async (_c: number, content: string) => {
        sent.text.push(content);
        return {};
      },
      sendAudioMessage: async () => {
        sent.audio++;
        return {};
      },
    } as unknown as ChatwootClient;
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: audioEvent(convId),
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: [REPLY] }),
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
        ttsFetch: countingProvider().fetchImpl,
        ttsCheck: check,
        ttsCheckFetch: detector,
      },
    });
    return { outcome, sent };
  }

  test("runtime, enforce and always corrupted: the customer gets the reply as text", async () => {
    const d = scriptedDetector([CORRUPTED]);
    const { outcome, sent } = await turnWith(7791, CHECK, d.fetchImpl);
    expect(outcome).toBe("posted");
    expect(sent.audio).toBe(0);
    expect(sent.text).toEqual([REPLY]);
    expect(d.rec.calls).toBe(3);
  });

  test("runtime, shadow and corrupted: the customer still gets the audio", async () => {
    const d = scriptedDetector([CORRUPTED]);
    const { outcome, sent } = await turnWith(
      7792,
      { ...CHECK, mode: "shadow" },
      d.fetchImpl,
    );
    expect(outcome).toBe("posted");
    expect(sent.audio).toBe(1);
    expect(sent.text).toEqual([]);
  });
});
