import { beforeAll, describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId, getCheckpointer } from "@/graph/checkpointer";
import { conversationDividerMessage, conversationStamp } from "@/graph/markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import { registerMemoryHandlers } from "@/modules/memory/compact";
import { runCompactionTick } from "@/modules/memory/worker";
import { getDeadLetterHandler, runClaimed } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// A compaction that will never happen has to SAY SO, in the trail the operator already reads by
// conversation (issue #196).
//
// The gap this file closes is specific to the summariser having its own provider, model, credential
// and endpoint: before that, compaction could only fail because the AGENT's model was broken, and a
// broken agent model fails every reply too, loudly. A configuration that fails only compaction is
// silent by construction — replies keep going out, and what stops is the memory, which is read on
// every later turn with that contact and is never rewritten.

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

// Only ever present in the seeded transcript, so a test can prove it did not reach a line that
// promises to carry no message text.
const SEEDED_TEXT = "carambola-com-manjericao-8812";

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let inboxDbId = 0n;

describe.skipIf(!dbUp)("a compaction that will never happen", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MDL", slug: `mdl-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 11,
      // Its OWN base URL, which is what makes the server key distinct. The helper stamps the pid into
      // the path so two RUNS do not collide, and `(server_key, account_id)` is unique globally — so
      // two FILES of the same run sharing a literal collide on whichever seeds second, and the P2002
      // surfaces in the other file's beforeAll, far from the file that caused it.
      baseUrl: "https://memory-dead-letter.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        // The motivating configuration, verbatim: a summariser pointed at a second vendor with no
        // credential of its own. Well-formed, saveable, and it fails every attempt at the resolver —
        // before any provider round-trip, so the failure is deterministic and costs nothing.
        settings: {
          memory: {
            compaction: {
              enabled: true,
              provider: "anthropic",
              model: "claude-haiku-4-5-20251001",
            },
          },
        },
      },
    });
    agentId = agent.id;
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 4242,
        name: "Suporte",
        agentId,
      },
      select: { id: true },
    });
    inboxDbId = inbox.id;
    registerMemoryHandlers();
  });

  // The closed attendance the job is armed for, mirrored on its inbox: together they are what the
  // trail line points AT, and what the Logs page filters on.
  async function seedConversation(chatwootConversationId: number) {
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId,
        inboxId: inboxDbId,
        status: "resolved",
        threadId: `${tenantId}:${instanceId}:${chatwootConversationId}`,
        lastEventAt: new Date(),
      },
      select: { id: true },
    });
    return conv.id;
  }

  // A thread with one CLOSED attendance and one open, on the REAL checkpointer: the handler under
  // test is reached through the scheduler with no injection at all, so nothing here can be green by
  // stubbing the thing that fails.
  async function seedThread(
    contactInboxId: number,
    closedId: number,
    openId: number,
  ) {
    const threadId = contactInboxThreadId(tenantId, instanceId, contactInboxId);
    const graph = buildThreadStateGraph(await getCheckpointer());
    const messages: BaseMessage[] = [
      new HumanMessage({
        content: `quero marcar uma avaliação, ${SEEDED_TEXT}`,
        additional_kwargs: conversationStamp(closedId),
      }),
      new AIMessage("Claro! Consegui terça 08h30, R$ 250."),
      new HumanMessage({
        content: "pode ser, obrigado",
        additional_kwargs: conversationStamp(closedId),
      }),
      conversationDividerMessage(openId, "oi, voltei"),
      new AIMessage("Oi! Como posso ajudar?"),
    ];
    for (const m of messages) {
      await graph.updateState(
        { configurable: { thread_id: threadId } },
        { messages: [m] },
        THREAD_STATE_NODE,
      );
    }
    await suDb.agentThread.upsert({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      create: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId,
        threadId,
      },
      update: {},
    });
    return threadId;
  }

  function jobPayload(contactInboxId: number, conversationId: number) {
    return {
      instanceId: String(instanceId),
      contactInboxId,
      conversationId,
      agentId: String(agentId),
      reason: "new_attendance",
    };
  }

  async function armedJob(
    dedupe: string,
    contactInboxId: number,
    conversationId: number,
    over: { attempts?: number; claimedAt?: Date } = {},
  ) {
    return suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "MEMORY_COMPACT",
        dedupeKey: dedupe,
        payload: jobPayload(contactInboxId, conversationId),
        runAt: new Date(),
        status: "CLAIMED",
        claimedAt: over.claimedAt ?? new Date(),
        attempts: over.attempts ?? 0,
        claimSeq: 0,
      },
      select: { id: true },
    });
  }

  function memoryLines(threadId: string) {
    return suDb.executionLog.findMany({
      where: { tenantId, stage: "memory", threadId },
      orderBy: { id: "asc" },
    });
  }

  // emitFlowEvent is fire-and-forget, so reading too early sees zero and proves nothing.
  async function waitForLines(threadId: string, n: number) {
    for (let i = 0; i < 40; i++) {
      if ((await memoryLines(threadId)).length >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ── The statement, and when it is made ───────────────────────────────────────────────────────
  test("the trail gets one line, on the attempt that gives up — not on the four before it", async () => {
    const ci = 6001;
    const convDbId = await seedConversation(860);
    const threadId = await seedThread(ci, 860, 861);
    const row = await armedJob(`mdl-dead-${process.pid}`, ci, 860);

    // MAX_ATTEMPTS is 5: the first four runs requeue, the fifth is the one that dead-letters. The
    // loop is also what makes the negative meaningful — each later iteration gives the earlier
    // (fire-and-forget) emit time to land, so "still zero" is a measurement rather than a race.
    for (let attempts = 0; attempts < 5; attempts++) {
      await suDb.schedulerJob.update({
        where: { id: row.id },
        data: { status: "CLAIMED", attempts },
      });
      await runClaimed(
        {
          id: row.id,
          tenantId,
          kind: "MEMORY_COMPACT",
          payload: jobPayload(ci, 860),
          attempts,
          claimSeq: 0,
        },
        appDb,
      );
      if (attempts < 4) {
        expect(await memoryLines(threadId)).toHaveLength(0);
      }
    }

    const after = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    expect(after.status).toBe("DEAD");

    await waitForLines(threadId, 1);
    const lines = await memoryLines(threadId);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    // An attendance nobody will ever summarise is not an advisory. `error` is also what puts it past
    // an alert channel's default minLevel, which is the point: the operator finds out now, not three
    // attendances later when the agent starts answering as if it had never met this contact.
    expect(line?.level).toBe("error");
    expect(line?.status).toBe("error");
    // Findable from the conversation. The Logs page filters on the database ids, so a line without
    // them exists and is invisible to the operator who opens the trail from the conversation.
    expect(line?.conversationId).toBe(convDbId);
    expect(line?.inboxId).toBe(inboxDbId);
    expect(line?.agentId).toBe(agentId);
    // The reason, or the line says only that something went wrong — and `provider_unknown` and "the
    // key is not entitled to that model" are different problems with different fixes.
    expect(line?.errorMessage ?? "").toMatch(
      /credential|runnable|memory compaction/i,
    );
    // Same promise the success line makes: ids, counts and enums, never the transcript.
    expect(JSON.stringify(line?.detail ?? {})).not.toContain(SEEDED_TEXT);
    expect(line?.errorMessage ?? "").not.toContain(SEEDED_TEXT);
  });

  // ── The other road to DEAD ───────────────────────────────────────────────────────────────────
  test("a compaction the compaction lane's own reaper kills is announced too", async () => {
    const ci = 6002;
    const convDbId = await seedConversation(862);
    const threadId = await seedThread(ci, 862, 863);
    // A claim that HUNG: the summary is a model call with a 60s ceiling, and a provider that never
    // answers ends here, not at failJob. This is the road with no `lastError` to read and no other
    // signal at all, so it is the one that most needs the line.
    const row = await armedJob(`mdl-reaped-${process.pid}`, ci, 862, {
      attempts: 4,
      claimedAt: new Date(Date.now() - 600_000),
    });

    // The lane's OWN tick, which is the only reaper of this kind when the scheduler worker is off —
    // a configuration the boot sequence explicitly supports — and which races the scheduler's reaper
    // for the row when it is on.
    await runCompactionTick(appDb, 0, {}, 5 * 60_000);

    const after = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    expect(after.status).toBe("DEAD");

    await waitForLines(threadId, 1);
    const lines = await memoryLines(threadId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect(lines[0]?.conversationId).toBe(convDbId);
  });

  test("compaction registers its dead-letter hook", () => {
    registerMemoryHandlers();
    expect(getDeadLetterHandler("MEMORY_COMPACT")).toBeDefined();
  });
});

// ── The family, swept ──────────────────────────────────────────────────────────────────────────
// Every reaper is a road to DEAD, and a lane that reaps its own kind and does not announce retires
// that kind's work in silence — which is exactly how this shipped: the scheduler tick announced, the
// compaction lane did not, and with both running which one announced was decided by whichever won
// the atomic UPDATE. A fourth lane will be written by copying a third, so the rule is asserted over
// the SOURCE rather than left for the next reviewer to notice.
test("every reaper announces the rows it dead-letters", async () => {
  const { Glob } = await import("bun");
  const offenders: string[] = [];
  for await (const file of new Glob("src/**/*.ts").scan(".")) {
    const src = await Bun.file(file).text();
    // The definition itself, not a call site.
    if (file.endsWith("scheduler/service.ts")) continue;
    if (!/\breapStaleJobs\b/.test(src)) continue;
    // The CALL, not the identifier: an import alone satisfies `\bannounceReaped\b`, so a file that
    // kept the import and dropped the call read as compliant. Measured — that is the exact mutation
    // this sweep failed to kill on its first draft.
    if (!/\bannounceReaped\(/.test(src)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
