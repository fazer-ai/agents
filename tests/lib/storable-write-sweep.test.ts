import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { sanitizeErrorMessage } from "@/lib/redact";
import { unstorableProblem } from "@/lib/text";
import { claimDueJobs, enqueueJob, failJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE GUARD AGAINST THE NEXT COLUMN THAT LOSES AN ERROR MESSAGE.
//
// Third instance of one shape, and the reason it is a sweep rather than a fourth call-site fix. The
// inbound receptor lost a delivery to a character in a third party's body (#218), both `jsonb`
// walkers behind the flow log and the audit log lost a row to the same thing (#241), and this file
// is the answer to the same question asked of every column that holds an ERROR message:
//
//   does this value reach a column, and has anything applied the rule the column enforces?
//
// The rule, measured against this project's own Postgres. A NUL is refused outright by `text` and by
// `jsonb` alike (22021 / 22P05). An unpaired surrogate is WORSE than refused in a `text` parameter:
// the driver spends one byte of the tail encoding its replacement, so `boom\ud800tail` lands as
// `boom<U+FFFD>tai` (one character eaten, silently) and only refuses at all when the orphan sits at
// the very end and the truncated `EF BF` becomes the last bytes.
//
// Error text is where this bites, and the demonstrated way a third party's bytes get in is an HTTP
// tool: it passes the remote endpoint's response body through verbatim so the model can read it,
// `toolFailure` makes that body the failure's cause, and with `observability.logToolValues` on the
// whole body reaches `execution_logs.error_message` (tests/graph/tool-flowlog.test.ts). Asking for
// detailed logging is what used to make the line disappear.
//
// The write it breaks is also the bookkeeping ABOUT a failure: `failJob` is the transition that
// either schedules the retry or dead-letters the job, so a refused write leaves the row CLAIMED
// with its old `attempts`, and nothing reclaims it, nothing reports it (issue #243).
//
// So `sanitizeErrorMessage` (src/lib/redact.ts) is the ONE place the rule is applied to error text,
// and this file is the check, in two halves:
//
//   1. its output survives every column that holds an error message, asserted at the ROW;
//   2. the source ledgers below account for every line that puts text in one of those columns, so a
//      new writer that reaches for a bare cut is a failure here rather than a job that stops moving.
//
// The second half exists because a table like the first proves the FUNCTION and nothing about
// whether the call sites call it (#205). What the ledgers pin is exactly that.
//
// NOT in scope, and stated so the ledgers are not read as a clean bill of health for the tree: this
// is the error family only. The wider question, every write of externally-sourced text into a
// column, reaches other places with other right answers (a model's own output, the text extracted
// from an uploaded file, the Chatwoot mirror, an OAuth client's own registration). Each needs its
// own reading of who can act on a refusal, which is exactly why they are not folded in here under
// one blanket policy.

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
      `provider said ${NUL} nothing`,
      appDb,
    );
    expect(r.applied).toBe(true);
    const row = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id },
      select: { status: true, attempts: true, lastError: true },
    });
    // The row moved: the retry is scheduled and the attempt was counted. Before the repair the
    // write was refused, the row stayed CLAIMED with attempts 0, and nothing reclaimed it.
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

// Every line in `src/` that names one of the two error columns whose key is unambiguous enough to
// scan for (`lastError`, `errorMessage`), with what it does there. The count per file is what makes
// a NEW line in an already-listed file trip this too, rather than only a new file.
//
//   flow-event  handed to emitFlowEvent as FlowEvent.errorMessage. Sanitized at the chokepoint in
//               flowlog/service.ts, so these are the one shape that legitimately passes a raw
//               exception message along: the guard sits between them and the column.
//   guarded     sanitizeErrorMessage applied right here, at the write
//   cleared     writes null (a row leaving the state the error described)
//   read        reads the column back out: a select, a filter, a DTO field
//   unrelated   the name, and none of the meaning: a field of a client-side shape that happens to
//               be called this. The scan cannot tell them apart, which is the honest limit of
//               keying on a name rather than on a write, and is why they are listed rather than
//               filtered out by a path rule that would also hide a real one.
type ErrorSite = "flow-event" | "guarded" | "cleared" | "read" | "unrelated";

const ERROR_COLUMN_LINES: Record<string, [number, ErrorSite | string]> = {
  "src/graph/nudge.ts": [1, "flow-event"],
  "src/graph/prepare.ts": [2, "flow-event"],
  "src/graph/runtime.ts": [4, "flow-event"],
  "src/graph/tool-flowlog.ts": [2, "flow-event"],
  // An upload row's own failure in the console, which never reaches a column.
  "src/client/pages/resources/useKnowledgeManager.tsx": [1, "unrelated"],
  "src/modules/chatwoot/webhook.ts": [1, "cleared"],
  "src/modules/contact-auth/service.ts": [1, "flow-event"],
  "src/modules/conversations/error.ts": [3, "guarded + cleared"],
  "src/modules/conversations/service.ts": [12, "read"],
  // Down from 4: both roads to DEAD now write through one `finalizeDead` (issue #356).
  "src/modules/flowlog/alert-worker.ts": [3, "guarded + cleared"],
  "src/modules/flowlog/dead-letter.ts": [1, "flow-event"],
  "src/modules/flowlog/read.ts": [4, "read"],
  "src/modules/flowlog/service.ts": [2, "guarded"],
  "src/modules/flowlog/webhook.ts": [1, "flow-event"],
  "src/modules/guardrails/gate.ts": [2, "flow-event"],
  "src/modules/guardrails/health.ts": [4, "read"],
  "src/modules/memory/compact.ts": [1, "flow-event"],
  "src/modules/scheduler/service.ts": [4, "guarded + cleared"],
  "src/modules/stt/service.ts": [2, "flow-event"],
  "src/modules/vision/service.ts": [2, "flow-event"],
  // Was 4 until issue #325 collapsed the two DEAD writes into `finalizeDead`; the line that went
  // is the duplicate, not a guard.
  // Three reads of `lastError`, and none of them a write: the DTO field, the projection that feeds
  // it, and the type. The ledger surfaces the column an operator uses to decide whether to requeue
  // (issue #305); the value was sanitized where the worker stored it.
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
  "src/modules/flowlog/alert-worker.ts": 1,
  "src/modules/flowlog/alerts.ts": 1,
  "src/modules/flowlog/service.ts": 2,
  "src/modules/rag/documents.ts": 1,
  "src/modules/scheduler/service.ts": 2,
  "src/modules/webhooks/outbound/worker.ts": 1,
};

async function countInSrc(re: RegExp): Promise<Record<string, number>> {
  const { Glob } = await import("bun");
  const found: Record<string, number> = {};
  for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
    const src = await Bun.file(`src/${rel}`).text();
    const n = (src.match(re) ?? []).length;
    if (n > 0) found[`src/${rel}`] = n;
  }
  return found;
}

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
