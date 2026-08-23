import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn } from "@/lib/tenancy";
import {
  runPlaygroundFollowup,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import {
  applyTurnNotes,
  deletePlaygroundSession,
  getPlaygroundSessionTurns,
  rebuildPlaygroundTurns,
} from "@/modules/playground/sessions";
import { listThreadTurnNotes } from "@/modules/playground/turn-notes";
import { guardrailModel } from "../utils/scripted-models";

// Issue #136: the playground ran the agent's graph directly and never screened anything, so the
// operator read a reply the customer would never have received. These tests are written against
// what the operator READS — the returned reply and the trace — because that is the artefact the
// issue is about; asserting that the gate was constructed would pass on a build that screens and
// then throws the verdict away.

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
let agentTemplate = 0n;
let agentSilent = 0n;
let agentInput = 0n;
let agentBrokenGuard = 0n;
let agentDeadCredential = 0n;
let agentBoth = 0n;
let agentInputSilent = 0n;

const RAW_REPLY = "Nosso concorrente resolve isso melhor.";
// Deliberately NOT the reader's own default template: an assertion against that string
// passes on a build that never read the agent's config at all.
const TEMPLATE = "[bloqueado pela política]";
const GUARD_MODEL = "guard-judge";

// Which model is being built decides which double comes back: the agent's own model answers the
// turn, the guardrails agent's model answers the verdict. Dispatching on the model NAME is what
// keeps a test that screens distinguishable from one that merely ran the agent twice.
function models(opts: {
  violated: boolean;
  breakJudge?: boolean;
  // Emits a calculator call before replying, so the graph contributes trace entries the guardrail
  // entries have to sit around. Without one in the middle, every ordering looks the same.
  toolFirst?: boolean;
  // The agent answers with nothing. The rebuild drops an empty AI message by design, so this is
  // what makes an id the note points at absent from the transcript.
  emptyReply?: boolean;
}) {
  let judgeCalls = 0;
  let agentInvokes = 0;
  const make = ((args: { model?: string }) => {
    if (args?.model === GUARD_MODEL) {
      if (opts.breakJudge) throw new Error("guardrail model unavailable");
      return guardrailModel(async () => {
        judgeCalls += 1;
        return {
          content: JSON.stringify({
            violated: opts.violated,
            categories: opts.violated ? ["competitor_mentions"] : [],
            rationale: opts.violated ? "names a competitor" : "",
            suggestedReply: null,
          }),
        };
      });
    }
    if (opts.toolFirst) {
      return {
        async invoke() {
          agentInvokes += 1;
          return new AIMessage(RAW_REPLY);
        },
        bindTools() {
          let n = 0;
          return {
            async invoke() {
              agentInvokes += 1;
              n += 1;
              return n === 1
                ? new AIMessage({
                    content: "",
                    tool_calls: [
                      {
                        name: "calculator",
                        args: { expression: "1+1" },
                        id: "c1",
                      },
                    ],
                  })
                : new AIMessage(RAW_REPLY);
            },
          };
        },
      } as unknown as BaseChatModel;
    }
    // Counts INVOCATIONS, not constructions. The graph is built before the input direction is
    // screened, so a counter on the factory reports one call for a turn that never ran the agent —
    // which is precisely the claim "the graph was skipped" is supposed to prove.
    const base = new FakeListChatModel({
      responses: [opts.emptyReply ? "" : RAW_REPLY],
    });
    const proxy: unknown = new Proxy(base, {
      get(t, prop, recv) {
        if (prop === "invoke") {
          return async (...a: unknown[]) => {
            agentInvokes += 1;
            const inner = t as unknown as {
              invoke: (...a: unknown[]) => Promise<unknown>;
            };
            return inner.invoke(...a);
          };
        }
        // Keep the count alive through the bind the graph does before invoking.
        if (prop === "bindTools") return () => proxy;
        return Reflect.get(t, prop, recv);
      },
    });
    return proxy as BaseChatModel;
  }) as never;
  return {
    make,
    judgeCalls: () => judgeCalls,
    agentInvokes: () => agentInvokes,
  };
}

const deps = (m: ReturnType<typeof models>) => ({
  makeModel: m.make,
  checkpointer: new MemorySaver(),
});

describe.skipIf(!dbUp)("playground guardrails (issue #136)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PGG", slug: `pgg-${process.pid}` },
    });
    tenantId = t.id;
    const key = async (name: string) =>
      `vault:${
        (
          await suDb.vaultEntry.create({
            data: { tenantId, name, secret: encryptJson("sk-test") },
            select: { id: true },
          })
        ).id
      }`;
    const llmRef = await key("llm-key");
    const guardRef = await key("guard-key");
    const mc = {
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: llmRef,
    };
    const guardrails = (over: Record<string, unknown>) => ({
      enabled: true,
      provider: "openai",
      model: GUARD_MODEL,
      credentialRef: guardRef,
      competitors: ["Concorrente"],
      ...over,
    });
    const onlyCompetitors = {
      toxicity: false,
      unsafeContent: false,
      competitorMentions: true,
      promptAdherence: false,
      answerRelevance: false,
    };
    // BOTH directions are declared on every agent, because both default to enabled: leaving one
    // implicit lets it screen first and answer for the direction under test, which is how the
    // silent-action case first reported the template.
    const dir = (over: object = {}) => ({
      enabled: false,
      action: "template",
      templateMessage: TEMPLATE,
      checks: onlyCompetitors,
      ...over,
    });
    const mk = (name: string, settings: object) =>
      suDb.agent
        .create({
          data: {
            tenantId,
            name,
            systemPrompt: "x",
            modelConfig: mc,
            settings: settings as never,
          },
        })
        .then((a) => a.id);

    const outputOnly = (over: object = {}) => ({
      guardrails: guardrails({
        input: dir(),
        output: dir({ enabled: true, ...over }),
      }),
    });

    agentTemplate = await mk("Template", outputOnly());
    agentSilent = await mk("Silent", outputOnly({ action: "silent" }));
    agentInput = await mk("Input", {
      guardrails: guardrails({ input: dir({ enabled: true }), output: dir() }),
    });
    agentBrokenGuard = await mk("Broken", outputOnly());
    // Enabled, with a credentialRef pointing at a vault entry that is not there (deleted, or from
    // another tenant). `prepare.ts` leaves the key empty and logs; the console shows a ref and an
    // available toggle, so this is the misconfiguration the operator cannot see from the editor.
    agentDeadCredential = await mk("DeadCredential", {
      guardrails: {
        ...guardrails({ input: dir(), output: dir({ enabled: true }) }),
        credentialRef: "vault:999999999",
      },
    });
    agentInputSilent = await mk("InputSilent", {
      guardrails: guardrails({
        input: dir({ enabled: true, action: "silent" }),
        output: dir(),
      }),
    });
    agentBoth = await mk("Both", {
      guardrails: guardrails({
        input: dir({ enabled: true }),
        output: dir({ enabled: true }),
      }),
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agentBoth,
        source: "NATIVE",
        enabledTools: ["calculator"],
        knowledgeBaseIds: [],
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "playground_media",
        "playground_turn_notes",
        "llm_usage",
        "agent_tool_selections",
        "execution_logs",
        "agents",
        "vault_entries",
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

  // The headline of the issue: the operator reads what the customer would read.
  test("an output violation replaces the reply the operator reads", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "e o concorrente?",
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe(TEMPLATE);
    expect(r.reply).not.toBe(RAW_REPLY);
    expect(m.judgeCalls()).toBe(1);
  });

  test("an output violation with the silent action leaves no reply at all", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentSilent,
      message: "e o concorrente?",
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe("");
  });

  // Faithful reproduction of the direction that does not merely alter the reply: it skips the graph.
  // Asserting the reply alone would pass on a build that ran the agent and then discarded its answer,
  // which is the same text and a different (and billed) thing.
  test("an input violation skips the graph: the agent model is never invoked", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "fale do concorrente",
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe(TEMPLATE);
    expect(m.agentInvokes()).toBe(0);
  });

  // Without this the operator cannot tell a moderated reply from an agent that answered badly, which
  // is the objection that decided "apply the action AND annotate" over either one alone.
  test("the verdict is annotated in the trace, with the direction and what it did", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "e o concorrente?",
      base: appDb,
      deps: deps(m),
    });
    const g = r.trace.filter((e) => e.type === "guardrail");
    expect(g.length).toBe(1);
    expect(g[0]).toMatchObject({
      type: "guardrail",
      direction: "output",
      outcome: "replaced",
      action: "template",
    });
  });

  // The case the issue names as the one the playground is the natural place to notice.
  test("a guardrail that cannot be built is fail-open, and says so in the trace", async () => {
    const m = models({ violated: false, breakJudge: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentBrokenGuard,
      message: "oi",
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe(RAW_REPLY);
    expect(r.trace.filter((e) => e.type === "guardrail")).toMatchObject([
      { outcome: "unavailable" },
    ]);
  });

  // Same case, one step earlier: the credential itself never resolved, so there is no model to try.
  // It used to report `not-run`, which is the answer for a guardrail the operator switched OFF, and
  // is the one of the issue's three cases that stayed invisible.
  test("a guardrail whose credential is gone is unavailable, not silently off", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentDeadCredential,
      message: "oi",
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe(RAW_REPLY);
    expect(r.trace.filter((e) => e.type === "guardrail")).toMatchObject([
      { outcome: "unavailable", direction: "output" },
    ]);
    // No key, so nothing was asked and nothing was billed.
    expect(m.judgeCalls()).toBe(0);
    // ...and the Logs page names it the way the rest of the fleet does. Six other features spell
    // this exact condition `credential_not_found` (the speech normalizer, vision, STT, TTS, memory
    // compaction, the OAuth controllers), and a seventh spelling is a filter that misses one.
    // Scoped to THIS agent, not just the tenant: every test here shares one tenant, and the
    // broken-model test a few lines up writes its own guardrail warn. Taking the newest row for the
    // tenant would read that one whenever this one has not landed yet (the emit is fire-and-forget).
    let detail: unknown;
    for (let i = 0; i < 50 && !detail; i++) {
      detail = (
        await suDb.executionLog.findFirst({
          where: {
            tenantId,
            agentId: agentDeadCredential,
            stage: "guardrail",
            level: "warn",
          },
          select: { detail: true },
        })
      )?.detail;
      if (!detail) await new Promise((r) => setTimeout(r, 100));
    }
    expect(detail).toMatchObject({ outcome: "credential_not_found" });
  });

  // A screening that ran and approved is still worth a line: "the guardrail is on and let this
  // through" and "the guardrail never ran" are different readings of the same clean reply.
  test("a clean screening is annotated too", async () => {
    const m = models({ violated: false });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "oi",
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe(RAW_REPLY);
    expect(r.trace.filter((e) => e.type === "guardrail")).toMatchObject([
      { outcome: "clean" },
    ]);
  });

  // The toggle exists because the pass is a model call the operator pays for, on a surface built for
  // rapid iteration. Off has to mean no call, not a discarded verdict.
  test("screening off leaves the raw reply and costs no guardrail call", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "e o concorrente?",
      guardrails: false,
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe(RAW_REPLY);
    expect(m.judgeCalls()).toBe(0);
    expect(r.trace.filter((e) => e.type === "guardrail")).toEqual([]);
  });

  // The trace is a SEQUENCE, and that is the whole reason it exists: an entry for the screening that
  // ran before the graph, rendered after the tool calls it preceded, tells the operator the wrong
  // story about when it happened.
  test("the trace keeps the screenings on the sides of the graph they ran on", async () => {
    const m = models({ violated: false, toolFirst: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentBoth,
      message: "quanto é 1+1?",
      base: appDb,
      deps: deps(m),
    });
    const shape = r.trace.map((e) =>
      e.type === "guardrail" ? `guardrail:${e.direction}` : e.type,
    );
    expect(shape[0]).toBe("guardrail:input");
    expect(shape.at(-1)).toBe("guardrail:output");
    // Proof the graph actually put something between them, so the assertion above is not vacuous.
    expect(shape.slice(1, -1)).toContain("tool_call");
  });

  // Findings from review round 1, all one cause: the guardrail's effect was returned and never
  // stored, so a reload rebuilt the transcript from the checkpointer and showed the reply the
  // guardrail took away. Asserted on the ROW, because the join over it is tabled separately.
  test("an output trip is recorded for the reload, with the screened text", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "e o concorrente?",
      base: appDb,
      deps: deps(m),
    });
    const rows = await suDb.playgroundTurnNote.findMany({
      where: { threadId: r.threadId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reply).toBe(TEMPLATE);
    expect(rows[0]?.messageId).toBeTruthy();
    expect(rows[0]?.guardrails).toMatchObject([{ outcome: "replaced" }]);
  });

  // The blocked turn is in NO store otherwise: the graph never ran, so the thread has neither the
  // message nor the reply, and a reload would simply lose the exchange.
  test("an input block is recorded with the customer's own text", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "fale do concorrente",
      base: appDb,
      deps: deps(m),
    });
    const rows = await suDb.playgroundTurnNote.findMany({
      where: { threadId: r.threadId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageId).toBeNull();
    expect(rows[0]?.userText).toBe("fale do concorrente");
    expect(rows[0]?.reply).toBe(TEMPLATE);
  });

  // The blocked path returned before the media save, so a blocked voice note lost the recording.
  test("an input block still persists the recording it blocked", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "<mensagem-de-audio>fale do concorrente</mensagem-de-audio>",
      userMedia: {
        kind: "user_audio",
        mime: "audio/webm",
        fileName: "nota.webm",
        bytes: new Uint8Array([1, 2, 3]).buffer,
      },
      base: appDb,
      deps: deps(m),
    });
    expect(r.userMediaId).toBeTruthy();
    const rows = await suDb.playgroundTurnNote.findMany({
      where: { threadId: r.threadId },
    });
    expect(rows[0]?.userMessageId).toBeTruthy();
    // The id the media hangs off has to be the SAME one the note carries, or the reload joins
    // nothing and the recording is there but unreachable.
    const media = await suDb.playgroundMedia.findMany({
      where: { threadId: r.threadId },
      select: { messageId: true },
    });
    expect(media[0]?.messageId).toBe(rows[0]?.userMessageId ?? "");
  });

  test("a turn the guardrail never touched writes no note", async () => {
    const m = models({ violated: false });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "oi",
      guardrails: false,
      base: appDb,
      deps: deps(m),
    });
    expect(
      await suDb.playgroundTurnNote.count({ where: { threadId: r.threadId } }),
    ).toBe(0);
  });

  // "Nothing was sent" has two causes and the operator needs them apart: reported as silence, the
  // client renders "the agent chose not to send anything" and discards the verdict with the trace.
  test("a suppressed follow-up is not reported as agent silence", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundFollowup({
      tenantId,
      agentId: agentSilent,
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe("");
    expect(r.suppressed).toBe(true);
    expect(r.silent).toBe(false);
    expect(r.trace.filter((e) => e.type === "guardrail")).toMatchObject([
      { outcome: "suppressed" },
    ]);
  });

  // The `silent` input action blocks the message and sends nothing at all, which is the case with no
  // reply text for the operator to read: without the flag the turn is a bare message and no reason.
  test("a silently blocked message reports suppression", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentInputSilent,
      message: "fale do concorrente",
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe("");
    expect(r.suppressed).toBe(true);
    expect(m.agentInvokes()).toBe(0);
  });

  // Both paths render from the same fact, which is what stops the live turn and the reload from
  // drifting apart one case at a time.
  test("a suppressed normal turn reports suppression, not an empty reply", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentSilent,
      message: "e o concorrente?",
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe("");
    expect(r.suppressed).toBe(true);
  });

  test("a reply the guardrail left alone is not reported as suppressed", async () => {
    const m = models({ violated: false });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "oi",
      base: appDb,
      deps: deps(m),
    });
    expect(r.suppressed).toBe(false);
  });

  // Same seam, the other end: the agent answers with nothing while the guardrail RAN. The note is
  // keyed to an AI message the rebuild drops, so before this it matched no turn and the verdict was
  // gone on reload. Asserted through the real checkpointer, because the defect lives between the
  // two stores and each half looked correct on its own.
  test("a screened turn the agent left empty keeps its verdict on reload", async () => {
    const cp = new MemorySaver();
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "primeira",
      base: appDb,
      deps: {
        makeModel: models({ violated: false, emptyReply: true }).make,
        checkpointer: cp,
      },
    });
    expect(r.trace.filter((e) => e.type === "guardrail")).toMatchObject([
      { outcome: "clean", direction: "input" },
    ]);
    // A SECOND turn, and it is the whole point: with one turn, "after the message it judged" and
    // "appended at the end" are the same position, so a test with one turn cannot tell a placed
    // verdict from a lost one that happened to land right.
    await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "segunda",
      threadId: r.threadId,
      base: appDb,
      deps: { makeModel: models({ violated: false }).make, checkpointer: cp },
    });

    const turns = applyTurnNotes(
      rebuildPlaygroundTurns(
        (
          (await cp.getTuple({ configurable: { thread_id: r.threadId } }))
            ?.checkpoint?.channel_values as { messages?: BaseMessage[] }
        )?.messages as BaseMessage[],
      ),
      await listThreadTurnNotes(appDb, tenantId, r.threadId),
    );
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      "user:primeira",
      "assistant:",
      "user:segunda",
      `assistant:${RAW_REPLY}`,
    ]);
    expect(turns[1]?.trace).toMatchObject([
      { type: "guardrail", outcome: "clean", direction: "input" },
    ]);
    // Nothing was taken away, so nothing claims it was.
    expect(turns[1]?.suppressed).toBeUndefined();
  });

  // Reload, end to end and through the REAL checkpointer, because every other assertion here is on
  // one half: the row that gets written, or the fold over a row handed in. Five review rounds found
  // the same defect in the seam between them, so the seam gets a test that spans it. The first turn
  // answers with nothing on purpose: the rebuild drops an empty AI message, so the raw tail of the
  // thread and the last message the transcript SHOWS are different ids, and an anchor taken from
  // the wrong one moves the blocked turn to the end.
  test("a reload renders the blocked turn in the place it happened", async () => {
    const silentModel = (() => ({
      async invoke() {
        return new AIMessage("");
      },
      bindTools() {
        return this;
      },
    })) as never;
    const first = await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "primeira",
      guardrails: false,
      base: appDb,
      deps: { makeModel: silentModel },
    });
    await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "fale do concorrente",
      threadId: first.threadId,
      base: appDb,
      deps: { makeModel: models({ violated: true }).make },
    });
    await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "terceira",
      threadId: first.threadId,
      base: appDb,
      deps: { makeModel: models({ violated: false }).make },
    });

    const turns = await getPlaygroundSessionTurns(
      tenantId,
      agentInput,
      first.threadId,
      appDb,
    );
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      "user:primeira",
      "user:fale do concorrente",
      `assistant:${TEMPLATE}`,
      "user:terceira",
      `assistant:${RAW_REPLY}`,
    ]);
    // The verdict rides the turn it belongs to, and nowhere else.
    const blocked = turns[2];
    expect(blocked?.trace).toMatchObject([
      { type: "guardrail", direction: "input" },
    ]);
    // A clean screening survives the reload too. Without it, reopening a session cannot tell a turn
    // that was screened and approved from one run with the toggle off, which is the ambiguity this
    // whole issue is about. The first turn ran with the toggle off and carries nothing.
    expect(turns[4]?.trace).toMatchObject([
      { type: "guardrail", outcome: "clean" },
    ]);
    expect(turns[0]?.trace.some((e) => e.type === "guardrail")).toBe(false);
  });

  // The anchor says where a thread-less turn goes, and `applyTurnNotes` resolves it against the
  // REBUILT turns — so an id the rebuild drops is an anchor nobody can match, and the note falls to
  // the end of a transcript it belongs in the middle of (the fallback is tabled in
  // playground-sessions.test.ts, and it is the failure this stops). An AI message with no text is
  // the case that produces one: the renderer drops it by design, and the raw thread ends on it.
  test("the anchor of a blocked turn is a message the rebuild keeps", async () => {
    const cp = new MemorySaver();
    // Turn 1: the agent answers with nothing, so the thread ends on an empty AI message.
    const silentModel = (() => ({
      async invoke() {
        return new AIMessage("");
      },
      bindTools() {
        return this;
      },
    })) as never;
    const first = await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "primeira",
      guardrails: false,
      base: appDb,
      deps: { makeModel: silentModel, checkpointer: cp },
    });
    // Turn 2, same thread: the input trips, so the turn exists only as a note.
    const m = models({ violated: true });
    await runPlaygroundTurn({
      tenantId,
      agentId: agentInput,
      message: "fale do concorrente",
      threadId: first.threadId,
      base: appDb,
      deps: { makeModel: m.make, checkpointer: cp },
    });

    const tuple = await cp.getTuple({
      configurable: { thread_id: first.threadId },
    });
    const messages = (
      tuple?.checkpoint?.channel_values as { messages?: BaseMessage[] }
    )?.messages as BaseMessage[];
    // The premise: the raw thread really does end on a message the rebuild throws away. Without it
    // this test would pass on the broken code too.
    // Only the ids the rebuild actually carries: a turn can have none, and `undefined` matching
    // `undefined` would make a null anchor look resolvable.
    const rendered = rebuildPlaygroundTurns(messages)
      .map((t) => t.messageId)
      .filter((id): id is string => typeof id === "string");
    const rawLast = (messages[messages.length - 1] as { id?: string })?.id;
    expect(rendered).not.toContain(rawLast);

    const rows = await suDb.playgroundTurnNote.findMany({
      where: { threadId: first.threadId },
      select: { anchorMessageId: true },
    });
    expect(rows).toHaveLength(1);
    const anchor = rows[0]?.anchorMessageId;
    expect(typeof anchor).toBe("string");
    expect(rendered).toContain(anchor as string);
  });

  // Every tenant-scoped model is registered with the tenancy extension, which supplies tenant_id on
  // insert so callers need not, and OVERRIDES a caller-supplied one (anti-spoof). The helper here
  // passes it explicitly, so nothing broke without the registration; what was missing is the
  // contract, and both halves of it are asserted through a plain scoped create.
  test("a turn note is written under the tenancy extension's own rules", async () => {
    const threadId = `${tenantId}:playground:${agentTemplate}:${crypto.randomUUID()}`;
    const other = await suDb.tenant.create({
      data: { name: "PGG-other", slug: `pgg-other-${process.pid}` },
    });
    await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      async (db) => {
        // No tenantId in the data at all: the extension supplies it.
        await db.playgroundTurnNote.create({
          data: {
            agentId: agentTemplate,
            threadId,
            reply: "sem tenant",
            guardrails: [],
          } as never,
          select: { id: true },
        });
        // ...and a foreign one is overridden rather than written or refused.
        await db.playgroundTurnNote.create({
          data: {
            tenantId: other.id,
            agentId: agentTemplate,
            threadId,
            reply: "tenant alheio",
            guardrails: [],
          },
          select: { id: true },
        });
      },
    );
    const rows = await suDb.playgroundTurnNote.findMany({
      where: { threadId },
      select: { tenantId: true, reply: true },
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => r.tenantId)).toEqual([tenantId, tenantId]);
    expect(rows.map((r) => r.reply)).toEqual(["sem tenant", "tenant alheio"]);
    await suDb.playgroundTurnNote.deleteMany({ where: { threadId } });
    await suDb.tenant.delete({ where: { id: other.id } });
  });

  // The note's life is the session's. Pruned on its own, a still-reloadable session would go back
  // to showing the raw reply the guardrail removed.
  test("deleting the session takes its transcript notes with it", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "e o concorrente?",
      base: appDb,
      deps: deps(m),
    });
    expect(
      await suDb.playgroundTurnNote.count({ where: { threadId: r.threadId } }),
    ).toBe(1);
    await deletePlaygroundSession(tenantId, agentTemplate, r.threadId, appDb);
    expect(
      await suDb.playgroundTurnNote.count({ where: { threadId: r.threadId } }),
    ).toBe(0);
  });

  // ...and the thread goes with them, which is the half that made deleting the notes safe. The turn
  // endpoint accepts any id that passes the tenant+agent fence, so a caller holding a deleted id
  // could open a turn on it: our rows were gone and the checkpoint was not, and the old raw reply
  // came back with nothing left to say a guardrail had removed it.
  //
  // Run on the REAL checkpointer, because an injected MemorySaver is not the store the delete
  // reaches and the whole defect is the two stores disagreeing.
  test("a deleted session cannot be reopened with its raw replies", async () => {
    const first = await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "fale do concorrente",
      base: appDb,
      deps: { makeModel: models({ violated: true }).make },
    });
    expect(first.reply).toBe(TEMPLATE);

    await deletePlaygroundSession(
      tenantId,
      agentTemplate,
      first.threadId,
      appDb,
    );

    // The same id, reused the way a caller that kept it would. A reply of its own, so the raw one
    // the first turn left behind cannot be mistaken for this turn's.
    await runPlaygroundTurn({
      tenantId,
      agentId: agentTemplate,
      message: "segunda",
      threadId: first.threadId,
      guardrails: false,
      base: appDb,
      deps: {
        makeModel: (() =>
          new FakeListChatModel({ responses: ["resposta nova"] })) as never,
      },
    });

    const turns = await getPlaygroundSessionTurns(
      tenantId,
      agentTemplate,
      first.threadId,
      appDb,
    );
    // Only the new turn. Before the thread was deleted too, this also carried "fale do concorrente"
    // and the raw reply the template had replaced, presented as the agent's own words.
    expect(turns.map((t) => t.text)).not.toContain("fale do concorrente");
    expect(turns.map((t) => t.text)).not.toContain(RAW_REPLY);
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      "user:segunda",
      "assistant:resposta nova",
    ]);
  });

  // The line that makes the delete safe to perform at all: `deleteThread` is scoped by nothing, and
  // every Chatwoot conversation lives in the same checkpointer.
  test("a thread outside the fence is refused, not deleted", async () => {
    await expect(
      deletePlaygroundSession(
        tenantId,
        agentTemplate,
        `${tenantId}:1:4242`,
        appDb,
      ),
    ).rejects.toThrow();
  });

  // Family sweep: the inbox's proactive path is screened (issue #160), so the playground's simulated
  // follow-up has to be, or the fix covers one of the two paths the playground reproduces.
  test("the simulated follow-up is screened on the output direction", async () => {
    const m = models({ violated: true });
    const r = await runPlaygroundFollowup({
      tenantId,
      agentId: agentTemplate,
      base: appDb,
      deps: deps(m),
    });
    expect(r.reply).toBe(TEMPLATE);
    expect(m.judgeCalls()).toBe(1);
  });
});
