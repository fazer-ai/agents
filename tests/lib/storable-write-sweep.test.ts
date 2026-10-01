import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { sanitizeErrorMessage } from "@/lib/redact";
import { unstorableProblem } from "@/lib/text";
import { claimDueJobs, enqueueJob, failJob } from "@/modules/scheduler/service";
// Both ledgers below count through the shared scan, so prose that NAMES a column or the guard is not
// counted as a use of it.
import { countInSrc } from "@/tests/utils/source-text";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE GUARD AGAINST THE NEXT COLUMN THAT LOSES AN ERROR MESSAGE. A NUL is refused by `text` and
// `jsonb` alike (22021 / 22P05), and an unpaired surrogate in a `text` parameter silently eats a tail
// byte (`boom\ud800tail` lands as `boom<U+FFFD>tai`). A third party's bytes reach error text through an
// HTTP tool, whose response body becomes the failure's cause and, with `logToolValues` on, reaches
// `execution_logs.error_message` (tests/graph/tool-flowlog.test.ts); a refused `failJob` write leaves
// the row CLAIMED, unretried and unreported. So `sanitizeErrorMessage` is the ONE place the rule is
// applied to error text: this file asserts its output at the ROW, and the ledgers below account for
// every call site. Error columns only (scope: docs/logs.md, Model).

const NUL = String.fromCharCode(0);

// Each is a message a provider, an HTTP tool or a third party can produce, and each is refused or
// corrupted by a `text` column as it stands. The last one is the ordering trap: dropping the NUL
// first would join the two orphan halves into U+10000, a character nobody wrote.
const BAD: [string, string][] = [
  ["NUL in the middle", `boom${NUL}tail`],
  ["NUL at the end", `boom${NUL}`],
  ["lone high surrogate, then text", "boom\ud800tail"],
  ["lone high surrogate at the end", "boom\ud800"],
  ["lone low surrogate, then text", "boom\udc00tail"],
  ["a NUL between two orphan halves", `\ud800${NUL}\udc00`],
];

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
let channelId = 0n;
let subscriptionId = 0n;
let knowledgeBaseId = 0n;

// Every column that holds an error message, with a write that puts the guard's OUTPUT in it and
// reads the stored value back. The claim is about the column, so the value is asserted where it
// landed rather than where it was produced.
const SINKS: { name: string; write: (v: string) => Promise<string | null> }[] =
  [
    {
      name: "execution_logs.error_message",
      write: async (v) => {
        const row = await suDb.executionLog.create({
          data: {
            tenantId,
            turnId: "sweep",
            stage: "generate",
            errorMessage: v,
          },
          select: { errorMessage: true },
        });
        return row.errorMessage;
      },
    },
    {
      name: "scheduler_jobs.last_error",
      write: async (v) => {
        const row = await suDb.schedulerJob.create({
          data: {
            tenantId,
            kind: "WEBHOOK_RETRY",
            dedupeKey: `sweep-${Math.random()}`,
            runAt: new Date(),
            lastError: v,
          },
          select: { lastError: true },
        });
        return row.lastError;
      },
    },
    {
      name: "alert_deliveries.summary",
      write: async (v) => {
        const row = await suDb.alertDelivery.create({
          data: { tenantId, channelId, level: "error", summary: v },
          select: { summary: true },
        });
        return row.summary;
      },
    },
    {
      name: "alert_deliveries.last_error",
      write: async (v) => {
        const row = await suDb.alertDelivery.create({
          data: {
            tenantId,
            channelId,
            level: "error",
            summary: "s",
            lastError: v,
          },
          select: { lastError: true },
        });
        return row.lastError;
      },
    },
    {
      name: "outbound_webhook_deliveries.last_error",
      write: async (v) => {
        const row = await suDb.outboundWebhookDelivery.create({
          data: { tenantId, subscriptionId, event: "sweep", lastError: v },
          select: { lastError: true },
        });
        return row.lastError;
      },
    },
    {
      name: "knowledge_documents.error",
      write: async (v) => {
        const row = await suDb.knowledgeDocument.create({
          data: {
            tenantId,
            knowledgeBaseId,
            title: "sweep",
            sourceType: "text",
            content: "c",
            status: "FAILED",
            error: v,
          },
          select: { error: true },
        });
        return row.error;
      },
    },
    {
      name: "conversations.last_error",
      write: async (v) => {
        const row = await suDb.conversation.update({
          where: { id: conversationRowId },
          data: { lastError: v },
          select: { lastError: true },
        });
        return row.lastError;
      },
    },
  ];

let conversationRowId = 0n;

describe.skipIf(!dbUp)("error text reaches every column that holds it", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SWEEP243", slug: `sweep243-${process.pid}` },
    });
    tenantId = t.id;
    const ch = await suDb.alertChannel.create({
      data: { tenantId, name: "c", type: "discord", url: "enc" },
      select: { id: true },
    });
    channelId = ch.id;
    const sub = await suDb.webhookSubscription.create({
      data: { tenantId, url: "https://example.test/hook", events: ["a"] },
      select: { id: true },
    });
    subscriptionId = sub.id;
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "kb" },
      select: { id: true },
    });
    knowledgeBaseId = kb.id;
    const inst = await seedChatwootInstance(suDb, { tenantId, accountId: 1 });
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootConversationId: 1,
        status: "open",
        threadId: `${tenantId}:${inst.id}:1`,
      },
      select: { id: true },
    });
    conversationRowId = conv.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  for (const sink of SINKS) {
    for (const [label, raw] of BAD) {
      test(`${sink.name} <- ${label}`, async () => {
        const guarded = sanitizeErrorMessage(raw);
        expect(unstorableProblem(guarded, "guarded")).toBeNull();
        const stored = await sink.write(guarded);
        expect(stored).toBe(guarded);
      });
    }
  }

  test("a failing job with a NUL still schedules its retry", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "sweep-failjob",
      runAt: new Date(Date.now() - 60_000),
      base: appDb,
    });
    const claimed = (await claimDueJobs(10, appDb, new Date(), tenantId)).find(
      (j) => j.id === id,
    );
    expect(claimed).toBeDefined();
    const r = await failJob(
      tenantId,
      id,
      claimed?.claimSeq ?? 0,
      claimed?.attempts ?? 0,
      "WEBHOOK_RETRY",
      `provider said ${NUL} nothing`,
      appDb,
    );
    expect(r.applied).toBe(true);
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { status: true, attempts: true, lastError: true },
    });
    // NOTE: The row moved: the retry is scheduled and the attempt was counted. A refused write would
    // leave it CLAIMED with attempts 0, and nothing would reclaim it.
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("provider said");
  });

  test("a NUL in the message still dead-letters the last attempt", async () => {
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "sweep-failjob-dead",
      runAt: new Date(Date.now() - 60_000),
      base: appDb,
    });
    const claimed = (await claimDueJobs(10, appDb, new Date(), tenantId)).find(
      (j) => j.id === id,
    );
    expect(claimed).toBeDefined();
    // One below MAX_ATTEMPTS, so this call is the one that gives up. It is the half that costs more
    // when the write is refused: a job that cannot reach DEAD is not merely un-retried, it is
    // absent from every list of what died.
    const r = await failJob(
      tenantId,
      id,
      claimed?.claimSeq ?? 0,
      4,
      "WEBHOOK_RETRY",
      `provider said ${NUL} nothing`,
      appDb,
    );
    expect(r.deadLettered).toBe(true);
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { status: true, lastError: true },
    });
    expect(row.status).toBe("DEAD");
    expect(row.lastError).toContain("provider said");
  });
});

// Every line in `src/` naming an error column whose key is unambiguous enough to scan for
// (`lastError`, `errorMessage`); counted per file, so a NEW line in a listed file trips this too.
// flow-event: handed to emitFlowEvent, sanitized at the chokepoint in flowlog/service.ts, the one
// shape that may pass a raw message along. guarded: sanitizeErrorMessage at the write. cleared:
// writes null. read: a select, a filter, a DTO field. unrelated: a client-side field that happens to
// share the name; listed rather than filtered by path, since a path rule would also hide a real one.
type ErrorSite = "flow-event" | "guarded" | "cleared" | "read" | "unrelated";

const ERROR_COLUMN_LINES: Record<string, [number, ErrorSite | string]> = {
  "src/graph/nudge.ts": [1, "flow-event"],
  "src/graph/prepare.ts": [2, "flow-event"],
  "src/graph/runtime.ts": [5, "flow-event"],
  "src/graph/tool-flowlog.ts": [2, "flow-event"],
  // A playground turn that failed unhandled: a fixed sentence, never the error's text.
  "src/modules/playground/service.ts": [1, "flow-event"],
  // An upload row's own failure in the console, which never reaches a column.
  "src/client/pages/resources/useKnowledgeManager.tsx": [1, "unrelated"],
  "src/modules/chatwoot/webhook.ts": [1, "cleared"],
  "src/modules/contact-auth/service.ts": [1, "flow-event"],
  "src/modules/conversations/error.ts": [3, "guarded + cleared"],
  "src/modules/conversations/service.ts": [12, "read"],
  // Both roads to DEAD write through one `finalizeDead`.
  "src/modules/flowlog/alert-worker.ts": [3, "guarded + cleared"],
  // The follow-up sweep's reading of the failure backoff: the type of the row it is handed. And the
  // line a lost follow-up sequence writes, a fixed English sentence.
  "src/modules/followups/handlers.ts": [2, "read + flow-event"],
  "src/modules/flowlog/dead-letter.ts": [1, "flow-event"],
  "src/modules/flowlog/read.ts": [4, "read"],
  "src/modules/flowlog/service.ts": [2, "guarded"],
  "src/modules/flowlog/webhook.ts": [1, "flow-event"],
  "src/modules/guardrails/gate.ts": [2, "flow-event"],
  // The guardrail's own transfer, when the status change is refused.
  "src/modules/guardrails/handoff.ts": [1, "flow-event"],
  "src/modules/guardrails/health.ts": [4, "read"],
  "src/modules/memory/compact.ts": [1, "flow-event"],
  "src/modules/observe/job.ts": [1, "flow-event"],
  // The follow-up sweep's re-arm reads the column to tell the scheduler's failure backoff from a row
  // that stood down: a select and the type it is handed as.
  "src/modules/scheduler/service.ts": [6, "guarded + cleared + read"],
  // The poll's failure line (the Langfuse error text) and its unpriced-model line (the model names
  // Langfuse answered with) travel as flow events.
  "src/modules/spend-ceiling/poll.ts": [3, "flow-event"],
  // The balloon send reports its failure without throwing: the flow line is the only place an
  // operator can see that part of a reply went missing.
  "src/modules/split/service.ts": [1, "flow-event"],
  "src/modules/stt/service.ts": [2, "flow-event"],
  // The audio check's "unavailable" line: a closed `audio check unavailable (<code>)`.
  "src/modules/tts/service.ts": [1, "flow-event"],
  "src/modules/vision/service.ts": [2, "flow-event"],
  // Three reads of `lastError`, and none of them a write: the DTO field, the projection that feeds
  // it, and the type. The ledger surfaces the column an operator uses to decide whether to requeue
  // and the value was sanitized where the worker stored it.
  "src/modules/webhooks/outbound/deliveries.ts": [3, "read"],
  "src/modules/webhooks/outbound/worker.ts": [3, "guarded + cleared"],
};

// The other half of the same ledger, and the half that covers the two columns the scan above cannot
// see: `knowledge_documents.error` and `alert_deliveries.summary` are named by keys (`error`,
// `summary`) far too common to grep for. Pinning where the guard is CALLED reaches them, and catches
// the removal of a call that the ledger above would read as an ordinary `read`.
const GUARD_CALLS: Record<string, number> = {
  "src/graph/tool-flowlog.ts": 2,
  "src/lib/redact.ts": 1,
  "src/modules/conversations/error.ts": 1,
  "src/modules/conversations/failure-note.ts": 1,
  // The worker's send, shared with the console's Test button, sanitizes in its own `catch`. The
  // column it guards (`alert_deliveries.last_error`) is written by the worker, from a string this
  // file built.
  "src/modules/flowlog/alert-send.ts": 1,
  "src/modules/flowlog/alerts.ts": 1,
  "src/modules/flowlog/service.ts": 2,
  "src/modules/rag/documents.ts": 1,
  // A knowledge source run's failure (the fetch, the reconcile), before it reaches `last_message`,
  // and the boot re-arm's before it reaches the log.
  "src/modules/rag/source.ts": 3,
  // The third reads it back: a run past its deadline takes its row back only while the row still
  // carries the failure that deadline wrote, compared in the form `failJob` stored it.
  "src/modules/scheduler/service.ts": 3,
  // The Langfuse error text, before it reaches `poll_error`.
  "src/modules/spend-ceiling/poll.ts": 1,
  "src/modules/webhooks/outbound/worker.ts": 1,
};

describe("every line that names an error column is accounted for", () => {
  test("the file list and the per-file counts still match", async () => {
    const found = await countInSrc(/\b(?:lastError|errorMessage)\s*:/g);
    const expected = Object.fromEntries(
      Object.entries(ERROR_COLUMN_LINES).map(([f, [n]]) => [f, n]),
    );
    expect(found).toEqual(expected);
  });

  test("the guard is still called everywhere it was", async () => {
    const found = await countInSrc(/sanitizeErrorMessage\(/g);
    expect(found).toEqual(GUARD_CALLS);
  });
});
