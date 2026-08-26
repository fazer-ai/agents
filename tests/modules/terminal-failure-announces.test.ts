import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { processAlertBatch } from "@/modules/flowlog/alert-worker";
import { registerRagIngestHandler } from "@/modules/rag/documents";
import {
  claimDueJobs,
  enqueueJob,
  reapStaleJobs,
} from "@/modules/scheduler/service";
import {
  announceReaped,
  getJobHandler,
  registerJobHandler,
  runClaimed,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";
import { updateEmbeddingSettings } from "@/modules/tenant-settings/service";
import {
  processInboundDelivery,
  receiveInbound,
} from "@/modules/webhooks/inbound/service";
import { clearFlowLog } from "@/tests/utils/flowlog";
import { withJobHandler } from "@/tests/utils/job-registry";

// ── A UNIT OF WORK THAT DIES PERMANENTLY HAS TO SAY SO (issue #356) ──
//
// Four buses reach a terminal failure state and, before this, three of them said nothing anywhere:
// the scheduler (for every kind without a hand-written hook), the alert bus, the inbound receptor,
// and the RAG indexer. The operator cannot infer any of them — by definition nothing happens
// afterwards — so the effect asserted here is always the durable row an operator reads
// (`ExecutionLog`), never a return value or a counter, because counting is exactly what did not
// reach anybody.
//
// Integration, real DB, real RLS. Only the network is injected.

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

const ctx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

let tenantId = 0n;
let kbId = 0n;
let channelId = 0n;
let instanceId = 0n;
let routeToken = "";

const past = () => new Date(Date.now() - 60_000);

// The emit is fire-and-forget, so the row lands after the caller returned. Poll for the expected
// count rather than sleeping a fixed amount: a fixed sleep is either flaky or slow, and this says
// which of the two it is when it fails.
async function deadRows(expected: number, waitMs = 4000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const rows = await suDb.executionLog.findMany({
      // flowlog-scope: tenant-wide — the subject is HOW MANY lines a terminal failure wrote, so a
      // reader scoped to one turn would answer a different question and stay green while a second,
      // duplicate line existed. None of these units HAS a turn; this file's tenant is its own, and
      // `clearRows` empties it before each case through `clearFlowLog`, which settles the scheduled
      // writes first — without that the emptying misses whatever the previous case had scheduled and
      // not yet written, and 23 cases share this tenant (issue #375).
      where: { tenantId, stage: "dead_letter" },
      orderBy: { id: "asc" },
    });
    if (rows.length >= expected) return rows;
    if (Date.now() > deadline) return rows;
    await Bun.sleep(50);
  }
}

async function clearRows() {
  await clearFlowLog(suDb, { tenantId });
  await suDb.$executeRaw`DELETE FROM alert_deliveries WHERE tenant_id = ${tenantId}`;
}

// ── the embedding provider, personified: an OpenAI-compatible /embeddings endpoint that refuses ──
let embedServer: ReturnType<typeof Bun.serve> | undefined;
let baseURL = "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BunRes = (globalThis as { BunResponse?: typeof Response })
  .BunResponse as typeof Response;

describe.skipIf(!dbUp)("a terminal failure announces itself", () => {
  beforeAll(async () => {
    embedServer = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "OPTIONS")
          return new BunRes(null, { status: 204, headers: cors });
        // 400, not 500: the OpenAI SDK retries 5xx, which would fire the run several times.
        return new BunRes(
          JSON.stringify({
            error: { message: "embedding rejected", type: "invalid_request" },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json", ...cors },
          },
        );
      },
    });
    baseURL = `http://127.0.0.1:${embedServer.port}/v1`;

    const t = await suDb.tenant.create({
      data: { name: "TF356", slug: `tf356-${process.pid}` },
    });
    tenantId = t.id;

    const cred = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "embed",
        kind: "generic",
        status: "active",
        secret: encryptJson({ apiKey: "test-key", baseURL }),
      },
    });
    await updateEmbeddingSettings(
      ctx(tenantId),
      { credentialRef: `vault:${cred.id}` },
      appDb,
    );
    kbId = (
      await suDb.knowledgeBase.create({
        data: {
          tenantId,
          name: "kb",
          embeddingModel: "text-embedding-3-small",
          chunkSize: 1000,
          chunkOverlap: 0,
        },
      })
    ).id;

    channelId = (
      await suDb.alertChannel.create({
        data: {
          tenantId,
          name: "all-stages",
          type: "webhook",
          url: encryptJson("https://example.com/alert-sink"),
          enabled: true,
          minLevel: "warn",
          stages: [],
        },
      })
    ).id;

    // An integration instance whose catalogType has no mapper registered: the shortest of the three
    // roads into `persistFailed`, and the one an operator cannot fix by re-sending.
    routeToken = `tok-356-${process.pid}`;
    const hash = new Bun.CryptoHasher("sha256")
      .update(routeToken)
      .digest("hex");
    instanceId = (
      await suDb.integrationInstance.create({
        data: {
          tenantId,
          catalogType: "no-such-catalog-356",
          name: "inbound",
          enabled: true,
          config: {},
          routeTokenHash: hash,
          inboundAuthStrategy: "NONE",
        },
      })
    ).id;
  });

  afterAll(async () => {
    embedServer?.stop(true);
    if (tenantId) {
      for (const tbl of [
        "execution_logs",
        "alert_deliveries",
        "alert_channels",
        "knowledge_chunks",
        "knowledge_documents",
        "knowledge_bases",
        "inbound_deliveries",
        "integration_instances",
        "vault_entries",
        "scheduler_jobs",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // ── THE SCHEDULER: the biggest half, and it was per kind ──

  test("the test harness puts the registry back, including when it was empty", async () => {
    // WEBHOOK_RETRY has no production handler at all — nothing registers one and nothing enqueues
    // the kind — so it is the case a restore that only re-registers a PREVIOUS handler gets wrong,
    // and the mistake is invisible from inside the file that makes it: the stub surfaces as another
    // file's scheduler test inheriting it, order-dependently.
    //
    // The absent state is SET UP here rather than assumed, because asserting it would be asserting
    // a global this file does not own — scheduler.test.ts installs a stub for this very kind and
    // does not put it back, which is the adjacent shape this helper cannot fix from here. Whatever
    // was there goes back at the end.
    const outer = getJobHandler("WEBHOOK_RETRY");
    unregisterJobHandler("WEBHOOK_RETRY");
    try {
      await withJobHandler(
        "WEBHOOK_RETRY",
        async () => ({ outcome: "done" }) as const,
        async () => {
          expect(getJobHandler("WEBHOOK_RETRY")).toBeDefined();
        },
      );
      expect(getJobHandler("WEBHOOK_RETRY")).toBeUndefined();
    } finally {
      if (outer) registerJobHandler("WEBHOOK_RETRY", outer);
    }
  });

  test("a job that exhausts its budget announces, for a kind with no hand-written hook", async () => {
    await clearRows();
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "WEBHOOK_RETRY",
      dedupeKey: "dk-356-exhaust",
      runAt: past(),
      base: appDb,
    });
    // Straight to the last attempt: the budget is 5 and the point is the transition, not the ladder.
    await suDb.schedulerJob.update({ where: { id }, data: { attempts: 4 } });
    const claimed = (await claimDueJobs(20, appDb, new Date(), tenantId)).find(
      (j) => j.id === id,
    );
    expect(claimed).toBeDefined();
    await withJobHandler(
      "WEBHOOK_RETRY",
      async () => {
        throw new Error("handler blew up");
      },
      () => runClaimed(claimed as NonNullable<typeof claimed>, appDb),
    );

    const row = await suDb.schedulerJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("DEAD");

    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    const line = rows[0] as (typeof rows)[number];
    expect(line.level).toBe("error");
    expect(line.status).toBe("error");
    const detail = line.detail as Record<string, unknown>;
    expect(detail.unit).toBe("job");
    expect(detail.kind).toBe("WEBHOOK_RETRY");
    expect(detail.jobId).toBe(String(id));
    expect(detail.dedupeKey).toBe("dk-356-exhaust");
    expect(line.errorMessage).toContain("handler blew up");
  });

  test("the reaper's road announces too, and says the claim never finished", async () => {
    await clearRows();
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "FLOWLOG_SWEEP",
      dedupeKey: "dk-356-reap",
      runAt: past(),
      base: appDb,
    });
    await suDb.schedulerJob.update({
      where: { id },
      data: {
        status: "CLAIMED",
        attempts: 4,
        claimedAt: new Date(Date.now() - 600_000),
      },
    });
    const reaped = await reapStaleJobs(5 * 60_000, appDb, new Date(), tenantId);
    expect(reaped.find((r) => r.id === id)?.status).toBe("DEAD");
    await announceReaped(reaped, appDb);

    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    const detail = (rows[0] as (typeof rows)[number]).detail as Record<
      string,
      unknown
    >;
    expect(detail.unit).toBe("job");
    expect(detail.kind).toBe("FLOWLOG_SWEEP");
    expect((rows[0] as (typeof rows)[number]).errorMessage).toContain(
      "the claim never finished",
    );
  });

  test("a RAG_INGEST death is a loss, because the recoverable half never reaches it", async () => {
    await clearRows();
    // Installed first so `withHandler` has the real one to put back: the registration is lazy and
    // may not have happened yet in this worker.
    registerRagIngestHandler();
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "RAG_INGEST",
      dedupeKey: "dk-356-level",
      runAt: past(),
      base: appDb,
    });
    await suDb.schedulerJob.update({ where: { id }, data: { attempts: 4 } });
    const claimed = (await claimDueJobs(20, appDb, new Date(), tenantId)).find(
      (j) => j.id === id,
    );
    await withJobHandler(
      "RAG_INGEST",
      async () => {
        throw new Error("indexing blew up");
      },
      () => runClaimed(claimed as NonNullable<typeof claimed>, appDb),
    );
    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    // The handler THROWS here, which is what a failure before `runIngestJobForTenant`'s catch looks
    // like to the scheduler (the scoped load, `resolveEmbeddingStatus`). The document is never
    // stamped FAILED, so it stays PENDING and `retryDocument` refuses it with a 409: nothing about
    // this is "look when you can". The recoverable case is announced by rag/documents.ts instead,
    // and that one IS `warn` — see the document test below.
    expect((rows[0] as (typeof rows)[number]).level).toBe("error");
  });

  test("a job re-armed under the announcement is not reported as lost", async () => {
    await clearRows();
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "FLOWLOG_SWEEP",
      dedupeKey: "dk-356-rearmed",
      runAt: past(),
      base: appDb,
    });
    await suDb.schedulerJob.update({
      where: { id },
      data: {
        status: "CLAIMED",
        attempts: 4,
        claimedAt: new Date(Date.now() - 600_000),
      },
    });
    const reaped = await reapStaleJobs(
      5 * 60_000,
      appDb,
      new Date(),
      tenantId,
      "FLOWLOG_SWEEP",
    );
    expect(reaped.find((r) => r.id === id)?.status).toBe("DEAD");
    // The re-arm: `upsertJobRow` keys on (tenant, kind, dedupeKey), so a sweep arming this work
    // again lands on THIS row. The reaped object in hand still says DEAD; the row does not.
    await suDb.schedulerJob.update({
      where: { id },
      data: { status: "PENDING", attempts: 0 },
    });
    await announceReaped(reaped, appDb);
    await Bun.sleep(400);
    expect(await deadRows(0, 0)).toHaveLength(0);
  });

  test("a failed re-read loses one line, never the rest of the batch", async () => {
    await clearRows();
    const ids: bigint[] = [];
    for (const k of ["a", "b"]) {
      const id = await enqueueJob({
        rearm: "same-work",
        tenantId,
        kind: "HEARTBEAT",
        dedupeKey: `dk-356-batch-${k}`,
        runAt: past(),
        base: appDb,
      });
      await suDb.schedulerJob.update({
        where: { id },
        data: {
          status: "CLAIMED",
          attempts: 4,
          claimedAt: new Date(Date.now() - 600_000),
        },
      });
      ids.push(id);
    }
    const reaped = (
      await reapStaleJobs(5 * 60_000, appDb, new Date(), tenantId, "HEARTBEAT")
    ).filter((r) => ids.includes(r.id));
    expect(reaped).toHaveLength(2);

    // The database, refusing exactly once. `announceReaped` walks a BATCH, and a throw escaping the
    // first job takes every later one with it — permanently, because a second reap will not return
    // a row that is already DEAD. The error is the real one seen in this suite's own runs.
    let scopedCalls = 0;
    const flaky = {
      $extends: (ext: unknown) => {
        const real = (
          appDb as unknown as {
            $extends: (e: unknown) => {
              $transaction: (fn: unknown, opts: unknown) => Promise<unknown>;
            };
          }
        ).$extends(ext);
        return {
          $transaction: (fn: unknown, opts: unknown) => {
            scopedCalls += 1;
            if (scopedCalls === 1)
              return Promise.reject(
                new Error(
                  "Timed out fetching a new connection from the connection pool",
                ),
              );
            return real.$transaction(fn, opts);
          },
        };
      },
    } as unknown as PrismaClient;

    await announceReaped(reaped, flaky);
    const rows = await deadRows(1);
    // The first job's read failed and its line is gone; the second is reported anyway.
    expect(rows).toHaveLength(1);
    const detail = (rows[0] as (typeof rows)[number]).detail as Record<
      string,
      unknown
    >;
    expect(detail.jobId).toBe(String(reaped[1]?.id));
  });

  test("a death that belongs to a later claim is not reported by the earlier one", async () => {
    await clearRows();
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "INGEST_MESSAGE",
      dedupeKey: "dk-356-generation",
      runAt: past(),
      base: appDb,
    });
    await suDb.schedulerJob.update({
      where: { id },
      data: {
        status: "CLAIMED",
        attempts: 4,
        claimedAt: new Date(Date.now() - 600_000),
      },
    });
    const reaped = await reapStaleJobs(
      5 * 60_000,
      appDb,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    expect(reaped.find((r) => r.id === id)?.status).toBe("DEAD");
    // The row is re-armed, taken by another drain and dies AGAIN before this announcement runs. It
    // reads as DEAD, but the death belongs to a later attempt with its own error — which announces
    // itself. Only the token tells the two apart; status cannot.
    await suDb.schedulerJob.update({
      where: { id },
      data: { claimSeq: { increment: 1 } },
    });
    await announceReaped(reaped, appDb);
    await Bun.sleep(400);
    expect(await deadRows(0, 0)).toHaveLength(0);
  });

  test("a kind that registers its own hook does not get the generic line as well", async () => {
    await clearRows();
    const { registerDebounceHandler } = await import(
      "@/modules/debounce/handler"
    );
    registerDebounceHandler();
    const id = await enqueueJob({
      rearm: "same-work",
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: "dk-356-own-hook",
      runAt: past(),
      base: appDb,
    });
    await suDb.schedulerJob.update({
      where: { id },
      data: {
        status: "CLAIMED",
        attempts: 4,
        claimedAt: new Date(Date.now() - 600_000),
      },
    });
    const reaped = await reapStaleJobs(
      5 * 60_000,
      appDb,
      new Date(),
      tenantId,
      "DEBOUNCE",
    );
    expect(reaped.find((r) => r.id === id)?.status).toBe("DEAD");
    await announceReaped(reaped, appDb);

    // Its hook owns the announcement for this kind (a private note on the conversation, issue #71),
    // and here it declines to write one — the payload carries no thread. The generic line must not
    // step in over that decision: the hook already looked and said no.
    await Bun.sleep(400);
    expect(await deadRows(0, 0)).toHaveLength(0);
  });

  // ── THE ALERT BUS: the sharp one, because it cannot notify through itself ──

  test("an alert the bus gave up on lands in the trail", async () => {
    await clearRows();
    const d = await suDb.alertDelivery.create({
      data: {
        tenantId,
        channelId,
        stage: "generate",
        level: "error",
        summary: "something failed",
        attempts: 7,
      },
    });
    const summary = await processAlertBatch({
      base: appDb,
      tenantId,
      // A fresh row waits out the coalescing window so its `count` can accumulate; these rows are
      // the burst's last one, not its first.
      coalesceWindowMs: 0,
      fetchImpl: (async () =>
        ({ status: 500 }) as Response) as unknown as typeof fetch,
      assertSafe: async (u: string) => new URL(u),
    });
    expect(summary.dead).toBe(1);
    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    const line = rows[0] as (typeof rows)[number];
    expect(line.level).toBe("error");
    const detail = line.detail as Record<string, unknown>;
    expect(detail.unit).toBe("alert_delivery");
    expect(detail.deliveryId).toBe(String(d.id));
    expect(detail.channelId).toBe(String(channelId));
    expect(detail.attempts).toBe(8);
  });

  test("and it does NOT queue another alert, which would never stop", async () => {
    await clearRows();
    await suDb.alertDelivery.create({
      data: {
        tenantId,
        channelId,
        stage: "generate",
        level: "error",
        summary: "something failed",
        attempts: 7,
      },
    });
    await processAlertBatch({
      base: appDb,
      tenantId,
      // A fresh row waits out the coalescing window so its `count` can accumulate; these rows are
      // the burst's last one, not its first.
      coalesceWindowMs: 0,
      fetchImpl: (async () =>
        ({ status: 500 }) as Response) as unknown as typeof fetch,
      assertSafe: async (u: string) => new URL(u),
    });
    await deadRows(1);
    // The channel this delivery died on subscribes to every stage. An alert ABOUT the dead alert
    // would be queued to that same broken channel, die, and queue another — one new row per death,
    // forever. The coalescing one layer down does not bound it: it bumps a PENDING row, and the
    // row this would follow is DEAD.
    await Bun.sleep(300);
    const deliveries = await suDb.alertDelivery.findMany({
      where: { tenantId },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("DEAD");
  });

  test("and it does not breed: four ticks against a broken channel stay at one", async () => {
    await clearRows();
    await suDb.alertDelivery.create({
      data: {
        tenantId,
        channelId,
        stage: "generate",
        level: "error",
        summary: "the turn failed",
        attempts: 7,
      },
    });
    // The claim above is one cycle; this is the sentence the PR body makes about ALL of them. The
    // measurement without the guard, on this same harness: cycle 1 leaves 1 DEAD + 1 PENDING, cycle
    // 6 leaves 6 DEAD + 1 PENDING and six lines. One new delivery per death, for as long as the
    // channel stays broken.
    const census: number[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      await processAlertBatch({
        base: appDb,
        tenantId,
        coalesceWindowMs: 0,
        fetchImpl: (async () =>
          ({ status: 500 }) as Response) as unknown as typeof fetch,
        assertSafe: async (u: string) => new URL(u),
      });
      await Bun.sleep(250);
      // Anything born in this cycle is made immediately claimable, so the next tick would kill it
      // and emit again — the loop runs at the retry ladder's pace, and this removes the wait.
      await suDb.alertDelivery.updateMany({
        where: { tenantId, status: "PENDING" },
        data: { nextAttemptAt: new Date(Date.now() - 1000), attempts: 7 },
      });
      census.push(await suDb.alertDelivery.count({ where: { tenantId } }));
    }
    expect(census).toEqual([1, 1, 1, 1]);
    expect(await deadRows(0, 0)).toHaveLength(1);
  });

  test("a blocked channel URL dies on the first attempt, and says so too", async () => {
    await clearRows();
    const blocked = (
      await suDb.alertChannel.create({
        data: {
          tenantId,
          name: "blocked",
          type: "webhook",
          url: encryptJson("http://example.com/insecure"),
          enabled: false,
          minLevel: "error",
          stages: [],
        },
      })
    ).id;
    await suDb.alertChannel.update({
      where: { id: blocked },
      data: { enabled: true },
    });
    const d = await suDb.alertDelivery.create({
      data: {
        tenantId,
        channelId: blocked,
        stage: "generate",
        level: "error",
        summary: "x",
        attempts: 0,
      },
    });
    const { assertSafeOutboundUrl } = await import("@/lib/ssrf");
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: (async () => {
        throw new Error("fetch must not be reached");
      }) as unknown as typeof fetch,
      assertSafe: assertSafeOutboundUrl,
    });
    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    const detail = (rows[0] as (typeof rows)[number]).detail as Record<
      string,
      unknown
    >;
    expect(detail.deliveryId).toBe(String(d.id));
    // No retry budget was spent, so an operator reading `attempts` must not conclude the sink was
    // tried eight times.
    expect(detail.attempts).toBe(1);
  });

  // ── THE INBOUND RECEPTOR ──

  test("an authenticated payload the receptor cannot process announces", async () => {
    await clearRows();
    const res = await receiveInbound({
      routeToken,
      rawBody: JSON.stringify({ event: "PAYMENT_RECEIVED", id: "pay_356" }),
      getHeader: () => null,
      base: appDb,
    });
    expect(res.outcome).toBe("no-mapper");
    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    const line = rows[0] as (typeof rows)[number];
    expect(line.level).toBe("error");
    const detail = line.detail as Record<string, unknown>;
    expect(detail.unit).toBe("inbound_delivery");
    expect(detail.deliveryId).toBe(String(res.deliveryId));
    expect(detail.integrationInstanceId).toBe(String(instanceId));
    expect(detail.reason).toBe("no-mapper");
  });

  test("the raw body never reaches the line", async () => {
    await clearRows();
    const marker = "sk-live-BODY-MUST-NOT-LEAK-356";
    await receiveInbound({
      routeToken,
      rawBody: JSON.stringify({ event: "X", secret: marker, id: "pay_356b" }),
      getHeader: () => null,
      base: appDb,
    });
    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0], (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(serialized).not.toContain(marker);
  });

  test("a provider retrying the same unprocessable body is reported once", async () => {
    await clearRows();
    const body = JSON.stringify({
      event: "PAYMENT_RECEIVED",
      id: "pay_356_dupe",
    });
    const first = await receiveInbound({
      routeToken,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    const again = await receiveInbound({
      routeToken,
      rawBody: body,
      getHeader: () => null,
      base: appDb,
    });
    // The dedupe key is a digest of the body, so the retry lands on the row that already exists.
    expect(again.deliveryId).toBe(first.deliveryId as bigint);
    await Bun.sleep(400);
    // One event was dropped, so one line. A provider that retries for a day would otherwise report
    // the same loss all day, at its own rate.
    expect(await deadRows(0, 0)).toHaveLength(1);
  });

  test("a delivery that burns through its processing attempts announces", async () => {
    await clearRows();
    const row = await suDb.inboundDelivery.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        dedupeKey: `poison-356-${process.pid}`,
        payload: { kind: "conversion" },
        status: "PENDING",
        // The cap is 5, and the claim below refuses a row that has reached it.
        attempts: 5,
      },
    });
    const outcome = await processInboundDelivery({
      deliveryId: row.id,
      tenantId,
      base: appDb,
    });
    expect(outcome).toBe("skipped");
    expect(
      (await suDb.inboundDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("FAILED");
    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    const line = rows[0] as (typeof rows)[number];
    expect(line.level).toBe("error");
    const detail = line.detail as Record<string, unknown>;
    expect(detail.unit).toBe("inbound_delivery");
    expect(detail.deliveryId).toBe(String(row.id));
    expect(detail.integrationInstanceId).toBe(String(instanceId));
    expect(detail.reason).toBe("attempts-exhausted");
  });

  test("a last attempt still in flight is neither killed nor announced", async () => {
    await clearRows();
    const row = await suDb.inboundDelivery.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        dedupeKey: `inflight-356-${process.pid}`,
        payload: { kind: "conversion" },
        // The fifth attempt, RUNNING right now: at the cap, claimed a moment ago — and RECEIVED
        // long before that, which is the shape the first version of this test missed. Four prior
        // deaths take time, so by the last attempt the receipt is always ancient; a staleness rule
        // read off `receivedAt` calls this row stale forever and the test passed for the wrong
        // reason with a fresh receipt.
        status: "PROCESSING",
        attempts: 5,
        receivedAt: new Date(Date.now() - 60 * 60_000),
        claimedAt: new Date(),
      },
    });
    // A duplicate webhook from the provider, arriving mid-flight.
    const outcome = await processInboundDelivery({
      deliveryId: row.id,
      tenantId,
      base: appDb,
    });
    expect(outcome).toBe("skipped");
    // The invocation still working on it may yet mark this PROCESSED, so nothing here may call it
    // terminally failed — the claim's own staleness rule is what says the row is still owned.
    expect(
      (await suDb.inboundDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("PROCESSING");
    await Bun.sleep(400);
    expect(await deadRows(0, 0)).toHaveLength(0);
  });

  test("a stale processing claim at the cap is killed, and says so", async () => {
    await clearRows();
    const row = await suDb.inboundDelivery.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        dedupeKey: `stale-356-${process.pid}`,
        payload: { kind: "conversion" },
        status: "PROCESSING",
        attempts: 5,
        receivedAt: new Date(Date.now() - 60 * 60_000),
        // Past the 5-minute cutoff on the CLAIM: whoever took this one is gone.
        claimedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await processInboundDelivery({
      deliveryId: row.id,
      tenantId,
      base: appDb,
    });
    expect(
      (await suDb.inboundDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("FAILED");
    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    expect(
      ((rows[0] as (typeof rows)[number]).detail as Record<string, unknown>)
        .reason,
    ).toBe("attempts-exhausted");
  });

  test("a delivery that was simply not reclaimable is not reported as lost", async () => {
    await clearRows();
    const row = await suDb.inboundDelivery.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        dedupeKey: `done-356-${process.pid}`,
        payload: {},
        status: "PROCESSED",
      },
    });
    const outcome = await processInboundDelivery({
      deliveryId: row.id,
      tenantId,
      base: appDb,
    });
    expect(outcome).toBe("skipped");
    // The claim and the attempt-cap kill share one branch, and only the second is a death. A row
    // another replica took a second ago reaches exactly the same `return { kind: "skip" }`.
    await Bun.sleep(400);
    expect(await deadRows(0, 0)).toHaveLength(0);
  });

  test("an unstamped row claimed a moment ago is not taken from under it", async () => {
    await clearRows();
    const row = await suDb.inboundDelivery.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        dedupeKey: `oldreplica-356-${process.pid}`,
        payload: { kind: "conversion" },
        status: "PROCESSING",
        attempts: 5,
        // The window the migration's own backfill cannot reach: a rolling pre-deploy leaves the
        // previous version CLAIMING rows after the UPDATE has run, so this row was taken seconds
        // ago by a replica that does not stamp. Reading NULL as stale would kill it mid-turn.
        receivedAt: new Date(Date.now() - 30_000),
        claimedAt: null,
      },
    });
    await processInboundDelivery({
      deliveryId: row.id,
      tenantId,
      base: appDb,
    });
    expect(
      (await suDb.inboundDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("PROCESSING");
    await Bun.sleep(400);
    expect(await deadRows(0, 0)).toHaveLength(0);
  });

  test("claiming stamps the clock the staleness rule reads", async () => {
    await clearRows();
    const row = await suDb.inboundDelivery.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        dedupeKey: `stamp-356-${process.pid}`,
        payload: { kind: "conversion" },
        status: "PENDING",
        // Below the cap, so this run takes the row rather than killing it.
        attempts: 0,
        receivedAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    await processInboundDelivery({
      deliveryId: row.id,
      tenantId,
      base: appDb,
    });
    const after = await suDb.inboundDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.attempts).toBe(1);
    // Without this stamp the whole rule reverts by omission: an unstamped row reads as stale
    // forever, which is exactly the state `receivedAt` left every row in.
    expect(after.claimedAt).not.toBeNull();
    expect((after.claimedAt as Date).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  test("an unstamped row falls back to the rule that shipped before the column", async () => {
    await clearRows();
    const row = await suDb.inboundDelivery.create({
      data: {
        tenantId,
        integrationInstanceId: instanceId,
        dedupeKey: `legacy-356-${process.pid}`,
        payload: { kind: "conversion" },
        status: "PROCESSING",
        attempts: 5,
        receivedAt: new Date(Date.now() - 60 * 60_000),
        // What a claim taken by a replica that does not stamp yet looks like. It is judged by the
        // receipt, which is exactly what shipped before this column — no worse than today for a row
        // the old code claimed, and the arm stops being reachable once every replica stamps.
        claimedAt: null,
      },
    });
    await processInboundDelivery({
      deliveryId: row.id,
      tenantId,
      base: appDb,
    });
    expect(
      (await suDb.inboundDelivery.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe("FAILED");
    expect(await deadRows(1)).toHaveLength(1);
  });

  // ── THE RAG INDEXER ──

  test("a document that will never be indexed announces", async () => {
    await clearRows();
    const { createDocument } = await import("@/modules/rag/documents");
    registerRagIngestHandler();
    const doc = await createDocument({
      ctx: ctx(tenantId),
      knowledgeBaseId: kbId,
      title: "doc-356",
      text: "a body long enough to chunk",
      sourceType: "text",
      base: appDb,
    });
    const handler = getJobHandler("RAG_INGEST");
    if (!handler) throw new Error("RAG_INGEST handler not registered");
    const out = await handler(
      {
        id: 0n,
        tenantId,
        kind: "RAG_INGEST",
        payload: { documentId: String(doc.id) },
        attempts: 0,
        claimSeq: 0,
      },
      appDb,
    );
    expect(out.outcome).toBe("fail");
    const stored = await runScopedOn(appDb, ctx(tenantId), (db) =>
      db.knowledgeDocument.findUniqueOrThrow({
        where: { id: doc.id },
        select: { status: true },
      }),
    );
    expect(stored.status).toBe("FAILED");

    const rows = await deadRows(1);
    expect(rows).toHaveLength(1);
    const line = rows[0] as (typeof rows)[number];
    // Recoverable by the operator (the document list shows FAILED and offers a re-index), so this
    // is the one site that is an advisory rather than a loss.
    expect(line.level).toBe("warn");
    const detail = line.detail as Record<string, unknown>;
    expect(detail.unit).toBe("knowledge_document");
    expect(detail.documentId).toBe(String(doc.id));
    expect(detail.knowledgeBaseId).toBe(String(kbId));
  });
});
