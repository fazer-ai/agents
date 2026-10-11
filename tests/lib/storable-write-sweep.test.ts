import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { sanitizeErrorMessage } from "@/lib/redact";
import { unstorableProblem } from "@/lib/text";
import { claimDueJobs, enqueueJob, failJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE GUARD AGAINST THE NEXT COLUMN THAT LOSES AN ERROR MESSAGE. A NUL is refused by `text` and
// `jsonb` alike (22021 / 22P05), and an unpaired surrogate in a `text` parameter silently eats a tail
// byte (`boom\ud800tail` lands as `boom<U+FFFD>tai`). A third party's bytes reach error text through an
// HTTP tool, whose response body becomes the failure's cause and, with `logToolValues` on, reaches
// `execution_logs.error_message` (tests/graph/tool-flowlog.test.ts); a refused `failJob` write leaves
// the row CLAIMED, unretried and unreported. So `sanitizeErrorMessage` is the ONE place the rule is
// applied to error text: this file asserts its output at the ROW. Error columns only (scope:
// docs/logs.md, Model); every call site is pinned in biome-plugins/pin-error-message-guard.grit.

const NUL = String.fromCharCode(0);

// Each is a message a provider, an HTTP tool or a third party can produce, and each is refused or
// corrupted by a `text` column as it stands, with the text the column must hold instead. The last one
// is the ordering trap: dropping the NUL first would join the two orphan halves into U+10000, a
// character nobody wrote.
const BAD: [string, string, string][] = [
  ["NUL in the middle", `boom${NUL}tail`, "boomtail"],
  ["NUL at the end", `boom${NUL}`, "boom"],
  ["lone high surrogate, then text", "boom\ud800tail", "boom\uFFFDtail"],
  ["lone high surrogate at the end", "boom\ud800", "boom"],
  ["lone low surrogate, then text", "boom\udc00tail", "boom\uFFFDtail"],
  ["a NUL between two orphan halves", `\ud800${NUL}\udc00`, "\uFFFD\uFFFD"],
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
    for (const [label, raw, repaired] of BAD) {
      test(`${sink.name} <- ${label}`, async () => {
        const guarded = sanitizeErrorMessage(raw);
        expect(unstorableProblem(guarded, "guarded")).toBeNull();
        expect(guarded).toBe(repaired);
        const stored = await sink.write(guarded);
        expect(stored).toBe(repaired);
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
