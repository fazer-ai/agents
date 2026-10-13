import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId, getCheckpointer } from "@/graph/checkpointer";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import { INGEST_ID_WINDOW } from "@/graph/ingest-dedup";
import { byMessageId, drainPendingIngest } from "@/graph/ingest-drain";
import {
  armIngest,
  fallbackHandler,
  ingestDedupeKey,
  ingestFallbackKey,
  ingestFallbackKeyPrefix,
  ingestHandler,
  ingestKeyPrefix,
  retireCoveredFallbacks,
} from "@/graph/ingest-job";
import { stampedSentAt } from "@/graph/markers";
import {
  currentPoolClass,
  type PoolClass,
  runInPoolClass,
} from "@/lib/pool-class";
import { runScopedOn } from "@/lib/tenancy";
import * as scheduler from "@/modules/scheduler/service";
import {
  type ClaimedJob,
  claimDueTrafficJobs,
  reapStaleJobs,
  rescheduleJob,
  revokeJobsByKeyPrefixOn,
} from "@/modules/scheduler/service";
import {
  getJobHandler,
  registerJobHandler,
  runClaimed,
} from "@/modules/scheduler/worker";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// Continuous ingestion is a job because a LangGraph invoke is a read-modify-write of the WHOLE
// message channel: a message appended beside a running turn is undone when that turn saves. Appended
// inline, the thread's own record would advance anyway, leaving the message gone AND marked handled.
// The job adds a third answer: put it down, come back.

let appDb: PrismaClient;
let suDb: PrismaClient;
let dbUp = true;
let tenantId = 0n;
let instanceId = 0n;

if (!process.env.TEST_APP_DATABASE_URL) {
  dbUp = false;
} else {
  appDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_APP_DATABASE_URL,
    }),
  });
  suDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_MIGRATION_DATABASE_URL,
    }),
  });
  try {
    await suDb.$queryRaw`SELECT 1`;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

describe.skipIf(!dbUp)("the ingestion job defers to a turn in flight", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "IJ", slug: `ij-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "agent_threads",
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

  // A REAL row, claimed the way the tick claims it, rather than a hand-built `ClaimedJob`. The
  // handler re-reads its own row under the lock to see whether it was revoked while it waited (a
  // /reset does exactly that), so a synthetic job with no row behind it is a job already cancelled,
  // and every test built that way would pass for the wrong reason.
  async function armAndClaim(
    contactInboxId: number,
    conversationId: number,
    messageId: number,
    text: string,
    sentAt?: Date,
  ): Promise<ClaimedJob> {
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId,
      contactInboxId,
      graphThreadId,
      messageId,
      text,
      role: "customer",
      ...(sentAt ? { sentAt } : {}),
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    const claimed = (
      await claimDueTrafficJobs(50, appDb, new Date(), tenantId)
    ).filter(
      (j) =>
        j.kind === "INGEST_MESSAGE" &&
        (j.payload as { messageId?: number }).messageId === messageId,
    );
    const job = claimed[0];
    if (!job) throw new Error("the armed ingestion job was not claimed");
    return job;
  }

  test("the message is not appended while a turn owns the thread, and is not lost", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12501;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const job = await armAndClaim(
      contactInboxId,
      980,
      300,
      "e o orçamento, saiu?",
    );
    const contents = async () => {
      const cp = await saver.get({
        configurable: { thread_id: graphThreadId },
      });
      return (
        ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
          []) as BaseMessage[]
      ).map((m) => String(m.content));
    };

    markTurnInFlight(graphThreadId);
    const deferred = await ingestHandler(job, appDb, saver);
    // `reschedule`, never `fail`: waiting on a turn is not an error, and spending an attempt on it
    // would dead-letter a contact's own message in a long conversation.
    expect(deferred.outcome).toBe("reschedule");

    // NOTE: The observable half. Nothing was appended, and the thread has no record claiming this
    // message was handled (the record whose advance would make the loss permanent), so the retry
    // still ingests it.
    expect(await contents()).toEqual([]);
    const owed = await suDb.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { recentSyncedMessageIds: true },
    });
    expect(owed?.recentSyncedMessageIds ?? []).toEqual([]);

    clearTurnInFlight(graphThreadId);
    const done = await ingestHandler(job, appDb, saver);
    expect(done.outcome).toBe("done");
    expect(await contents()).toEqual([
      expect.stringContaining("e o orçamento, saiu?"),
    ]);
  });

  // `encryptJson` returns a base64 blob, which lives in a plain String column, never a Prisma `Json`
  // one: a Json payload is what gets logged or serialized whole, and it would carry a contact's own
  // words with it. The ciphertext has its own column, and the JSON holds metadata only. The instant
  // Chatwoot recorded crosses the queue with the message, so a message folded in while nobody
  // answered is still shown to the model with the date it was sent.
  test("the message's instant crosses the queue and lands on the message", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12555;
    const at = new Date("2026-09-16T13:05:00.000Z");
    const job = await armAndClaim(contactInboxId, 981, 310, "segue", at);
    expect((job.payload as { sentAt?: string }).sentAt).toBe(at.toISOString());
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    const cp = await saver.get({
      configurable: {
        thread_id: contactInboxThreadId(tenantId, instanceId, contactInboxId),
      },
    });
    const [m] = ((cp?.channel_values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(m && stampedSentAt(m)).toEqual(at);
  });

  test("a job armed without one, by an older build or a caller that did not know, stays undated", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12556;
    const job = await armAndClaim(contactInboxId, 982, 311, "oi");
    expect("sentAt" in (job.payload as object)).toBe(false);
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    const cp = await saver.get({
      configurable: {
        thread_id: contactInboxThreadId(tenantId, instanceId, contactInboxId),
      },
    });
    const [m] = ((cp?.channel_values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(m && stampedSentAt(m)).toBeNull();
  });

  test("the message body is stored outside the JSON payload", async () => {
    const contactInboxId = 12510;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const SECRET = "o cartão termina em 4471";
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 989,
      contactInboxId,
      graphThreadId,
      messageId: 820,
      text: SECRET,
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: `ingest:${graphThreadId}:820` },
      select: { payload: true, payloadSecret: true },
    });
    // Neither the words nor their ciphertext are anywhere in the JSON.
    const asJson = JSON.stringify(row.payload);
    expect(asJson).not.toContain(SECRET);
    expect(asJson).not.toContain(String(row.payloadSecret));
    expect(asJson).not.toContain("text");
    // And the column that does hold it is still readable, so the split did not lose the body.
    expect(decryptJson<string>(String(row.payloadSecret))).toBe(SECRET);
  });

  // The guard that pays for `ClaimedJob.payloadSecret` being optional. A query that forgot to select
  // the column hands the handler a job with no body, and the quiet reading of that is an empty
  // message: ingestion skips empty text, so the job would report success and the contact's words
  // would be gone with nothing anywhere saying so. It throws instead, which the scheduler turns into
  // a retry and then a visible dead-letter.
  test("a job with no body throws instead of ingesting an empty message", async () => {
    const saver = new MemorySaver();
    const job = await armAndClaim(12511, 990, 830, "some words");
    expect(
      ingestHandler({ ...job, payloadSecret: null }, appDb, saver),
    ).rejects.toThrow(/no message body/);
  });

  // /reset clears this thread's summaries, AgentThread row and checkpoint under the `ingest:<thread>`
  // lock, and revokes queued ingestion with them. The worst shape is a job already CLAIMED and blocked
  // on that lock: it would land the instant the reset releases and rebuild the thread from text the
  // operator was told had been cleared, with the reset reported as successful. Staged the way it
  // happens: the job is claimed FIRST (past every check a cancellation could reach), and the
  // revocation runs while it waits.
  test("a job revoked by a reset while it waited writes nothing", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12508;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const job = await armAndClaim(
      contactInboxId,
      987,
      800,
      "isso é de antes do reset",
    );

    // What /reset does to queued ingestion, from inside its own critical section.
    await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        revokeJobsByKeyPrefixOn(
          db,
          "INGEST_MESSAGE",
          `ingest:${graphThreadId}:`,
        ),
    );

    // The handler runs anyway — it was already claimed — and must come back having written nothing.
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    expect(
      ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ?? [])
        .length,
    ).toBe(0);
    // And the thread was not rebuilt: no row, which is what the reset had just made true.
    expect(
      await suDb.agentThread.count({
        where: { tenantId, chatwootInstanceId: instanceId, contactInboxId },
      }),
    ).toBe(0);
  });

  // THE REVOKE ORDERS ROWS AGAINST THE COMMAND. `/reset` waits for `withKeyedQueue('ingest:<thread>')`
  // behind whatever ingestion is in flight, and `armIngest` does not take that queue, so a customer
  // message landing in that stretch arms its own ingestion and is above the command by id. An
  // unqualified revoke would delete it, and delete rather than retire, because INGEST_MESSAGE is
  // JOB_DELETE_ON_DONE, so nothing afterwards would say it ever existed.
  test("revoking up to a message spares the rows above it, in every status", async () => {
    const contactInboxId = 12_520;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const semear = async (
      messageId: number,
      status: "PENDING" | "CLAIMED" | "DEAD",
    ) =>
      suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: ingestDedupeKey(graphThreadId, messageId),
          runAt: new Date(),
          status,
          payload: { messageId },
        },
      });
    for (const [id, st] of [
      [700, "PENDING"],
      [701, "CLAIMED"],
      [702, "DEAD"],
      // ON the boundary, which is the command's own message: `/reset` arrives as an incoming
      // message like any other and arms its own ingestion, and that one has to go. This is the row
      // that separates `lte` from `lt`, and without it an off-by-one leaves the command text itself
      // queued to be appended to the thread it just cleared.
      [800, "PENDING"],
      [900, "PENDING"],
      [901, "CLAIMED"],
      [902, "DEAD"],
    ] as const) {
      await semear(id, st);
    }

    const apagadas = await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        revokeJobsByKeyPrefixOn(
          db,
          "INGEST_MESSAGE",
          `ingest:${graphThreadId}:`,
          800,
        ),
    );
    expect(apagadas.count).toBe(4);
    const restantes = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: { startsWith: `ingest:${graphThreadId}:` },
      },
      select: { dedupeKey: true, status: true },
      orderBy: { dedupeKey: "asc" },
    });
    // DEAD is spared on this side for the same reason it is taken on the other: the revoke takes
    // DEAD because the row holds the encrypted body of a message the reset was asked to erase, and a
    // DEAD row for a message that arrived AFTER the command holds a body it was never asked to
    // erase — plus a dead-letter the operator may still need to read.
    expect(restantes.map((r) => `${r.dedupeKey}=${r.status}`)).toEqual([
      `ingest:${graphThreadId}:900=PENDING`,
      `ingest:${graphThreadId}:901=CLAIMED`,
      `ingest:${graphThreadId}:902=DEAD`,
    ]);
    // NOTE: The boundary changes how many deaths come back: the revoke returns each death it erased,
    // so its announcement is not lost with the row, and the boundary erases fewer rows. 702 died
    // below the command and comes back; 902 died above, stays DEAD and still owes its announcement
    // through the normal dead-letter path. Announcing a spared row as erased would claim a deletion
    // Postgres never made.
    expect(apagadas.erasedDeaths.map((d) => d.dedupeKey)).toEqual([
      `ingest:${graphThreadId}:702`,
    ]);
  });

  // THE KEY DECIDES, NOT THE PAYLOAD. `payload` is a convenience copy a row could be missing; the key
  // cannot be, because `ingestDedupeKey` builds it and the prefix is everything up to the message id.
  // A payload-driven fence gets one side wrong either way: "delete what is at or below" leaves the
  // undecidable row BELOW the boundary holding text the reset must erase, and "delete what is not
  // provably above" deletes the undecidable row ABOVE it, the customer message this fence saves.
  // The rows are fabricated (`armIngest` writes key and payload from the same variable): what is
  // pinned is the direction the code fails in if a second writer ever appears.
  test("the key decides, so a payload that names no message spares nothing and loses nothing", async () => {
    const contactInboxId = 12_522;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const semear = async (messageId: number, payload: unknown) =>
      suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: ingestDedupeKey(graphThreadId, messageId),
          runAt: new Date(),
          status: "PENDING",
          payload: payload as never,
        },
      });
    // Below the boundary with nothing in the payload: goes, because the key says 700.
    await semear(700, {});
    // Above it with nothing in the payload: STAYS, because the key says 900. This is the clause a
    // payload-driven fence fails, and it is the expensive half — a customer message disappearing.
    await semear(900, {});
    // Explicit null behaves like the absent key, and the key still answers.
    await semear(901, { messageId: null });
    // And when the two disagree, the key wins: this payload claims to be from before the boundary.
    await semear(902, { messageId: 1 });
    // Three keys the reader cannot parse, seeded by hand because `ingestDedupeKey` cannot produce
    // them: no suffix at all, a suffix that is not decimal, and one too long for the bigint the
    // comparison casts to. All three go, because "above" is what spares and none of them proves it.
    // The last one also says why the parse is bounded rather than `[0-9]+`: an unbounded cast would
    // abort the whole reset on a row like this instead of deleting it.
    for (const chave of [
      `ingest:${graphThreadId}:`,
      `ingest:${graphThreadId}:9a0`,
      `ingest:${graphThreadId}:99999999999999999999`,
    ]) {
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: chave,
          runAt: new Date(),
          status: "PENDING",
          payload: {},
        },
      });
    }
    // And a neighbouring thread whose id starts with this one's, which only the trailing colon on
    // the prefix keeps out: `…:ci:12522` against `…:ci:125220`.
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: ingestDedupeKey(
          contactInboxThreadId(tenantId, instanceId, 125_220),
          700,
        ),
        runAt: new Date(),
        status: "PENDING",
        payload: {},
      },
    });

    const apagadas = await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        revokeJobsByKeyPrefixOn(
          db,
          "INGEST_MESSAGE",
          `ingest:${graphThreadId}:`,
          800,
        ),
    );
    expect(apagadas.count).toBe(4);
    const restantes = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: { startsWith: `ingest:${graphThreadId}:` },
      },
      select: { dedupeKey: true },
      orderBy: { dedupeKey: "asc" },
    });
    expect(restantes.map((r) => r.dedupeKey)).toEqual([
      `ingest:${graphThreadId}:900`,
      `ingest:${graphThreadId}:901`,
      `ingest:${graphThreadId}:902`,
    ]);
  });

  // ONE STATEMENT, AND THAT IS THE ASSERTION. Reading the ids with `findMany` and deleting by id
  // reads correctly and is still wrong: the caller's transaction runs at READ COMMITTED and
  // `armIngest` takes neither the thread's queue nor its conversation row, so a delayed pre-reset
  // delivery arming BETWEEN the two statements would survive the reset. One statement sees rows
  // committed up to its own start. Asserted structurally because the race needs a second connection
  // committing inside the reset; the kind is asserted with the count, since a count alone would pass
  // a form that reads once and deletes once under another name.
  test("the bounded revoke is a single DELETE, not a read followed by a delete", async () => {
    const contactInboxId = 12_523;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    for (const id of [700, 900]) {
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: ingestDedupeKey(graphThreadId, id),
          runAt: new Date(),
          status: "PENDING",
          payload: { messageId: id },
        },
      });
    }
    // Its own client, because the shared one is built without the query log and the count has to
    // come from what Postgres was actually asked, not from reading the source.
    const espiao = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.TEST_APP_DATABASE_URL,
      }),
      log: [{ emit: "event", level: "query" }],
    } as never);
    const sql: string[] = [];
    (
      espiao as unknown as {
        $on: (e: string, f: (q: { query: string }) => void) => void;
      }
    ).$on("query", (q) => {
      if (q.query.includes("scheduler_jobs")) sql.push(q.query);
    });
    try {
      await runScopedOn(
        espiao,
        { tenantId, userId: null, role: "TENANT_ADMIN" },
        (db) =>
          revokeJobsByKeyPrefixOn(
            db,
            "INGEST_MESSAGE",
            `ingest:${graphThreadId}:`,
            800,
          ),
      );
    } finally {
      await espiao.$disconnect();
    }
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^\s*DELETE FROM scheduler_jobs/i);
    // And it did the work, so the assertion is about a statement that ran rather than one that was
    // skipped: 700 goes, 900 stays.
    const restantes = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: { startsWith: `ingest:${graphThreadId}:` },
      },
      select: { dedupeKey: true },
    });
    expect(restantes.map((r) => r.dedupeKey)).toEqual([
      ingestDedupeKey(graphThreadId, 900),
    ]);
  });

  // ...AND A COMMAND THAT NAMED NO MESSAGE STILL TAKES EVERYTHING. `commandMessageId` is
  // `params.n.message?.id ?? null`, so a reset that did not arrive as a message writes no boundary
  // and has nothing to order rows against. The OBSERVE cancel SKIPS itself in that case, and this
  // one must not: its job is to stop text from before the reset landing back in a cleared thread,
  // and that duty does not depend on the command having an id. The two look alike and part here, so
  // the asymmetry is asserted rather than left to be re-aligned by shape.
  test("revoking with no boundary takes every row under the prefix", async () => {
    const contactInboxId = 12_521;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    for (const [id, st] of [
      [700, "PENDING"],
      [901, "CLAIMED"],
      [902, "DEAD"],
    ] as const) {
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: ingestDedupeKey(graphThreadId, id),
          runAt: new Date(),
          status: st,
          payload: { messageId: id },
        },
      });
    }
    const apagadas = await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        revokeJobsByKeyPrefixOn(
          db,
          "INGEST_MESSAGE",
          `ingest:${graphThreadId}:`,
        ),
    );
    expect(apagadas.count).toBe(3);
    expect(
      await suDb.schedulerJob.count({
        where: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: { startsWith: `ingest:${graphThreadId}:` },
        },
      }),
    ).toBe(0);
  });

  // The other half of that fence: `claimSeq`, not just the status. A duplicate delivery re-arms the
  // row to PENDING without touching claimSeq, and the tick can then CLAIM it again, which bumps the
  // sequence and starts a second run while the first still waits on the thread lock. Two runs of one
  // key at once is what the scheduler avoids everywhere else; the first one stands down and the row
  // belongs to the claim that holds it.
  test("a job whose row was claimed again stands down for the newer run", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12509;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const first = await armAndClaim(
      contactInboxId,
      988,
      810,
      "quem escreve é a reivindicação mais nova",
    );
    // A duplicate delivery re-arms the row, and the tick claims it again.
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 988,
      contactInboxId,
      graphThreadId,
      messageId: 810,
      text: "quem escreve é a reivindicação mais nova",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    const second = (
      await claimDueTrafficJobs(50, appDb, new Date(), tenantId)
    ).find((j) => j.id === first.id);
    expect(second?.claimSeq).toBe(first.claimSeq + 1);

    // The FIRST run, finally through the lock, finds the row is no longer its own.
    expect((await ingestHandler(first, appDb, saver)).outcome).toBe("done");
    expect(
      (
        (
          (await saver.get({ configurable: { thread_id: graphThreadId } }))
            ?.channel_values as { messages?: BaseMessage[] }
        )?.messages ?? []
      ).length,
    ).toBe(0);

    // The newer one writes, so the message is not lost by standing down.
    if (!second) throw new Error("the re-armed row was not claimed again");
    expect((await ingestHandler(second, appDb, saver)).outcome).toBe("done");
    expect(
      (
        (
          (await saver.get({ configurable: { thread_id: graphThreadId } }))
            ?.channel_values as { messages?: BaseMessage[] }
        )?.messages ?? []
      ).length,
    ).toBe(1);
  });

  // The dedupe key. `enqueueJob` keeps ONE live row per (tenant, kind, dedupeKey) and a re-enqueue
  // REPLACES the payload, so a key scoped to the thread would let the second message of a burst
  // overwrite the first before either ran: the loss this job exists to stop, one layer out and
  // harder to see, because the thread would look healthy.
  test("two messages queued on one thread are two jobs, not one", async () => {
    const contactInboxId = 12503;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (messageId: number, text: string) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 982,
        contactInboxId,
        graphThreadId,
        messageId,
        text,
        role: "customer",
        agentId: 1n,
        compactionEnabled: false,
        base: appDb,
      });

    await arm(400, "primeira da rajada");
    await arm(401, "segunda da rajada");

    // Claimed from the traffic-proportional half of the shared lane, so ingestion does not
    // compete with the fixed-rate kinds for the same batch (src/modules/scheduler/lanes.ts).
    const claimed = await claimDueTrafficJobs(50, appDb, new Date(), tenantId);
    // Read from the dedicated column, not from the JSON: the ciphertext of a contact's own words
    // does not live in `payload` (CLAUDE.md, Encryption).
    const texts = claimed
      .filter((j) => j.kind === "INGEST_MESSAGE")
      .map((j) => decryptJson<string>(String(j.payloadSecret)));
    expect(texts.sort()).toEqual(["primeira da rajada", "segunda da rajada"]);
    for (const job of claimed) await runClaimed(job, appDb);
  });

  // THE BARRIER. A queued append gives up synchronous ordering: a turn can start while a message meant
  // for its context is still a row. The turn drains its own thread first, and the drain ignores
  // `run_at`: a job DEFERRED for a previous turn sits a minute in the future, and those are exactly
  // the messages a due-only drain would skip. The turn runs on whichever replica the webhook landed
  // on and this job on the leader, so an in-process registry of reading turns is empty here. The
  // other replica is personified by what it leaves behind, the row; marking through the module would
  // mark THIS process's registry and pass on a mechanism that cannot see the other replica.
  test("a turn held on another replica defers the append", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12561;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const job = await armAndClaim(contactInboxId, 981, 305, "ficou pronto?");
    await suDb.$executeRawUnsafe(
      `INSERT INTO agent_threads
         (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id,
          turn_holders, turn_held_until, created_at, updated_at)
       VALUES (${tenantId}, ${instanceId}, ${contactInboxId}, '${graphThreadId}',
          1, now() + interval '5 minutes', now(), now())`,
    );

    const deferred = await ingestHandler(job, appDb, saver);
    expect(deferred.outcome).toBe("reschedule");

    const cp = await saver.get({ configurable: { thread_id: graphThreadId } });
    expect(
      ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
        []) as BaseMessage[],
    ).toEqual([]);
    // And the thread does not claim the message was handled, so it is still OWED. That pairing is
    // the whole difference between a late message and a lost one.
    const owed = await suDb.agentThread.findUniqueOrThrow({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { recentSyncedMessageIds: true },
    });
    expect(owed.recentSyncedMessageIds).toEqual([]);

    // The remote turn ends. Nothing in this process ever knew about it, and the retry ingests.
    await suDb.$executeRawUnsafe(
      `UPDATE agent_threads SET turn_holders = 0, turn_held_until = NULL
        WHERE tenant_id = ${tenantId} AND contact_inbox_id = ${contactInboxId}`,
    );
    const done = await ingestHandler(job, appDb, saver);
    expect(done.outcome).toBe("done");
    const after = await saver.get({
      configurable: { thread_id: graphThreadId },
    });
    expect(
      (
        ((after?.channel_values as { messages?: BaseMessage[] })?.messages ??
          []) as BaseMessage[]
      ).map((m) => String(m.content)),
    ).toContain("ficou pronto?");
  });

  // INGEST_MESSAGE is a background kind, but a turn that drains its thread waits on the drain, so the
  // drain runs on the turn's pool: behind a held background pool the turn would answer without the
  // messages it was waiting for.
  test("a turn's drain runs the ingestion on the turn's own pool", async () => {
    const contactInboxId = 12510;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 990,
      contactInboxId,
      graphThreadId,
      messageId: 900,
      text: "e mais uma coisa",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    const real = getJobHandler("INGEST_MESSAGE");
    const seen: PoolClass[] = [];
    registerJobHandler("INGEST_MESSAGE", (job, base, ctl) => {
      seen.push(currentPoolClass());
      return (real as NonNullable<typeof real>)(job, base, ctl);
    });
    try {
      await runInPoolClass("main", () =>
        drainPendingIngest(tenantId, graphThreadId, appDb),
      );
    } finally {
      registerJobHandler("INGEST_MESSAGE", real as NonNullable<typeof real>);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["main"]));
  });

  test("a turn drains its thread first, deferred rows included", async () => {
    const contactInboxId = 12504;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 983,
      contactInboxId,
      graphThreadId,
      messageId: 500,
      text: "esqueci de dizer: é urgente",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    // Push it into the future, which is what a deferral leaves behind.
    await suDb.$executeRawUnsafe(
      `UPDATE scheduler_jobs SET run_at = now() + interval '1 hour'
        WHERE tenant_id = ${tenantId} AND kind = 'INGEST_MESSAGE'
          AND dedupe_key = 'ingest:${graphThreadId}:500'`,
    );
    // A due-only claim does not see it, which is the trap this guards.
    expect(
      (await claimDueTrafficJobs(50, appDb, new Date(), tenantId)).filter(
        (j) => j.kind === "INGEST_MESSAGE",
      ),
    ).toEqual([]);

    await drainPendingIngest(tenantId, graphThreadId, appDb);

    const at = await suDb.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { recentSyncedMessageIds: true },
    });
    expect(at?.recentSyncedMessageIds).toEqual([500]);
    // Completed ingestion rows are DELETED, not left DONE: the key names one message, so nothing
    // ever reuses the row and nothing sweeps this table.
    // Named by its own key: other cases in this file leave rows of this kind behind on purpose (a
    // claim that was never completed, a revoked one), and a tenant-wide count would read those as
    // this row surviving.
    const left = await suDb.schedulerJob.count({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: `ingest:${graphThreadId}:500`,
      },
    });
    expect(left).toBe(0);
  });

  // A CLAIMED row counts as OWED, which lets compaction refuse to summarise an attendance whose
  // messages are still coming, and would also turn one crash into a permanent stall. Ingestion has no
  // tick of its own: these readers are its only path, and the drain claims PENDING rows only, so a
  // row left CLAIMED by a dead process would be owed forever and every later compaction on that
  // thread would reschedule and never run.
  test("a claim left behind by a dead process is reaped, not owed forever", async () => {
    const contactInboxId = 12506;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 985,
      contactInboxId,
      graphThreadId,
      messageId: 700,
      text: "ficou claimed quando o processo caiu",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    // What a crash leaves: CLAIMED, and claimed long enough ago to be presumed dead.
    await suDb.$executeRawUnsafe(
      `UPDATE scheduler_jobs SET status = 'CLAIMED', claimed_at = now() - interval '30 minutes'
        WHERE tenant_id = ${tenantId} AND dedupe_key = 'ingest:${graphThreadId}:700'`,
    );

    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "drained",
    );
    // Reaped, then run, then deleted — and the message it was carrying is folded in rather than
    // stranded, which is what separates a reap from simply not counting stale claims.
    expect(
      await suDb.schedulerJob.count({
        where: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: `ingest:${graphThreadId}:700`,
        },
      }),
    ).toBe(0);
    const at = await suDb.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { recentSyncedMessageIds: true },
    });
    expect(at?.recentSyncedMessageIds).toEqual([700]);
  });

  // The other side of that reap, and the reason it has an age at all: a claim taken a moment ago is
  // a job another process is running RIGHT NOW. Reaping it would put the same message through
  // ingestion twice at once, and the drain must instead report the thread as still owing something —
  // which is exactly what makes compaction wait rather than summarise without it.
  test("a claim taken a moment ago is left alone, and still counts as owed", async () => {
    const contactInboxId = 12507;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 986,
      contactInboxId,
      graphThreadId,
      messageId: 701,
      text: "outro processo está com essa agora",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    // A minute ago, not `now()`: the cutoff is computed from the HOST clock and written against the
    // database's, and those differ by seconds on a Docker Postgres. At `now()` the assertion would
    // turn on that skew and pass for whichever reason the machine happened to supply. A minute is
    // unambiguously inside the five-minute window and unambiguously in the past.
    await suDb.$executeRawUnsafe(
      `UPDATE scheduler_jobs SET status = 'CLAIMED', claimed_at = now() - interval '1 minute'
        WHERE tenant_id = ${tenantId} AND dedupe_key = 'ingest:${graphThreadId}:701'`,
    );

    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "incomplete",
    );
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: `ingest:${graphThreadId}:701` },
      select: { status: true, attempts: true },
    });
    expect(row.status).toBe("CLAIMED");
    // Untouched: a reap bumps attempts, and spending one on a job that is running would bring it
    // closer to being dead-lettered for someone else's success.
    expect(row.attempts).toBe(0);
  });

  // The drain ignores run_at so it can see a job deferred for an EARLIER turn, and that same waiver
  // defeats failure backoff: a row that just failed is immediately due again. Without excluding what
  // it has already touched, one drain re-claims the same failing row on every pass and spends the
  // whole retry budget inside a single turn — dead-lettering a customer's message in milliseconds,
  // using up the very budget that exists for coming back later.
  test("one drain spends one attempt on a failing row, not the whole budget", async () => {
    const contactInboxId = 12505;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 984,
      contactInboxId,
      graphThreadId,
      messageId: 600,
      text: "isso aqui vai falhar",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    // Make the handler throw deterministically: an instanceId that is not a number at all.
    await suDb.$executeRawUnsafe(
      `UPDATE scheduler_jobs SET payload = jsonb_set(payload, '{instanceId}', '"nao-e-numero"')
        WHERE tenant_id = ${tenantId} AND dedupe_key = 'ingest:${graphThreadId}:600'`,
    );

    await drainPendingIngest(tenantId, graphThreadId, appDb);

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: `ingest:${graphThreadId}:600` },
      select: { attempts: true, status: true },
    });
    expect(row.attempts).toBe(1);
    // Still retryable, and by the tick rather than by this turn.
    expect(row.status).toBe("PENDING");
  });

  // What the drain's exclusion list guards, with the claim itself honouring backoff: the DEFERRAL
  // loop. A job that stands down for a turn keeps `attempts` at zero, so it stays claimable, and the
  // drain makes five passes. Without the list it would claim and defer the same row once per pass,
  // five times over, inside a customer's turn.
  test("one drain claims a deferring row once, not once per pass", async () => {
    const contactInboxId = 12513;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 992,
      contactInboxId,
      graphThreadId,
      messageId: 850,
      text: "chega no meio de um turno",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });

    // A turn owns the thread for the whole drain, so every pass would defer.
    markTurnInFlight(graphThreadId);
    try {
      expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
        "incomplete",
      );
    } finally {
      clearTurnInFlight(graphThreadId);
    }

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: `ingest:${graphThreadId}:850` },
      select: { claimSeq: true, attempts: true, status: true },
    });
    // A claim bumps claimSeq; one drain must account for exactly one.
    expect(row.claimSeq).toBe(1);
    // And a deferral is not a failure, so nothing was spent.
    expect(row.attempts).toBe(0);
    expect(row.status).toBe("PENDING");
  });

  // The question the test above answers inside ONE drain, asked across several. Each turn opens its
  // own drain with an empty exclusion list, so the run_at waiver that lets the barrier see a DEFERRED
  // job would make a failed row due again immediately for the next turn: a burst with debounce off,
  // or a turn and a nudge, would spend all five attempts within seconds and dead-letter a customer's
  // message over a database blip. A failed row carries `last_error` and a deferred one does not
  // (the next test).
  test("a failed row keeps its backoff across drains, and is still owed", async () => {
    const contactInboxId = 12512;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 991,
      contactInboxId,
      graphThreadId,
      messageId: 840,
      text: "isso aqui vai falhar",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    // Make the handler throw deterministically, then let one drain spend the first attempt.
    await suDb.$executeRawUnsafe(
      `UPDATE scheduler_jobs SET payload = jsonb_set(payload, '{instanceId}', '"nao-e-numero"')
        WHERE tenant_id = ${tenantId} AND dedupe_key = 'ingest:${graphThreadId}:840'`,
    );
    await drainPendingIngest(tenantId, graphThreadId, appDb);
    const afterFirst = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: `ingest:${graphThreadId}:840` },
      select: { attempts: true, runAt: true, status: true },
    });
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.status).toBe("PENDING");
    expect(afterFirst.runAt.getTime()).toBeGreaterThan(Date.now());

    // A SECOND turn, a fresh drain. It must not touch the row: the backoff is the only thing
    // standing between a transient failure and a dead-lettered message.
    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "incomplete",
    );
    const afterSecond = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: `ingest:${graphThreadId}:840` },
      select: { attempts: true },
    });
    expect(afterSecond.attempts).toBe(1);
    // And `incomplete` is the half that keeps this safe rather than merely slower: the thread still
    // owes a message, so compaction will not summarise the attendance without it.
  });

  // The barrier tells a row that is BACKING OFF from one that merely STOOD DOWN by `last_error`, the
  // state itself, which a reschedule clears. `attempts` answers a different question: a row can carry
  // a spent budget with no error, and reading it would skip the very message the barrier folds in.
  // The state is built with the REAPER because a reschedule clears the budget too, so fail-then-defer
  // cannot construct the divergence; `reapStaleJobs` increments `attempts` and never writes
  // `last_error`. A test that could not build its own offending state would pass guarding nothing.
  test("a job whose claim died and then deferred is still drained", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12514;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const job = await armAndClaim(
      contactInboxId,
      993,
      860,
      "falhou uma vez, depois esperou um turno",
    );
    // It stands down for a turn first: the row goes to a future run_at carrying no error.
    markTurnInFlight(graphThreadId);
    try {
      expect((await ingestHandler(job, appDb, saver)).outcome).toBe(
        "reschedule",
      );
      await rescheduleJob(
        tenantId,
        job.id,
        job.claimSeq,
        new Date(Date.now() + 60_000),
        undefined,
        appDb,
      );
    } finally {
      clearTurnInFlight(graphThreadId);
    }

    // Then a claim on it dies. The reaper re-pends the row and charges the crash, leaving the
    // future run_at alone and writing no error: a spent budget on a row that merely stood down.
    const claimed = (
      await claimDueTrafficJobs(
        50,
        appDb,
        new Date(Date.now() + 600_000),
        tenantId,
      )
    ).find((j) => j.id === job.id);
    if (!claimed) throw new Error("the deferred row was not re-claimed");
    await suDb.schedulerJob.update({
      where: { id: job.id },
      data: {
        claimedAt: new Date(Date.now() - 3_600_000),
        runAt: new Date(Date.now() + 60_000),
      },
    });
    await reapStaleJobs(60_000, appDb, new Date(), tenantId, "INGEST_MESSAGE");

    const deferred = await suDb.schedulerJob.findFirstOrThrow({
      where: { id: job.id },
      select: { attempts: true, lastError: true, runAt: true, status: true },
    });
    expect(deferred.status).toBe("PENDING");
    expect(deferred.attempts).toBe(1);
    expect(deferred.lastError).toBeNull();
    expect(deferred.runAt.getTime()).toBeGreaterThan(Date.now());

    // The next turn's barrier must see it, future run_at and all: this is a deferral, not a backoff.
    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "drained",
    );
    const at = await suDb.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { recentSyncedMessageIds: true },
    });
    expect(at?.recentSyncedMessageIds).toEqual([860]);
  });

  // Two turns really do overlap on one thread (../../src/graph/inflight.ts counts rather than sets),
  // and a deferral that read the count as a boolean flag would resume on the FIRST release while the
  // second invoke is still reading — appending into exactly the window it stood down for.
  test("one release of two claims is still a turn in flight", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12502;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const job = await armAndClaim(contactInboxId, 981, 301, "ainda estou aqui");

    markTurnInFlight(graphThreadId);
    markTurnInFlight(graphThreadId);
    clearTurnInFlight(graphThreadId);
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("reschedule");

    clearTurnInFlight(graphThreadId);
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
  });

  // A watcher that left the append to the memory owner arms a fallback of its own kind: no memory line
  // while it waits, and when it runs it arms the ordinary append only where the message has none.
  async function armFallbackAndClaim(
    contactInboxId: number,
    messageId: number,
    text: string,
  ): Promise<{ job: ClaimedJob; graphThreadId: string }> {
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 990,
      contactInboxId,
      graphThreadId,
      messageId,
      text,
      role: "customer",
      agentId: 2n,
      compactionEnabled: false,
      fallbackAfterMs: 10 * 60_000,
      base: appDb,
    });
    const notYet = await claimDueTrafficJobs(50, appDb, new Date(), tenantId);
    expect(notYet.some((j) => j.kind === "INGEST_FALLBACK")).toBe(false);
    const job = (
      await claimDueTrafficJobs(
        50,
        appDb,
        new Date(Date.now() + 11 * 60_000),
        tenantId,
      )
    ).find(
      (j) =>
        j.kind === "INGEST_FALLBACK" &&
        j.dedupeKey === ingestFallbackKey(graphThreadId, messageId),
    );
    if (!job) throw new Error("the fallback was not claimed once due");
    return { job, graphThreadId };
  }

  // What a fallback's own run wrote into the thread, read off the checkpointer it was given.
  async function appendedTexts(saver: MemorySaver, graphThreadId: string) {
    const saved = await saver.get({
      configurable: { thread_id: graphThreadId },
    });
    return (
      (saved?.channel_values as { messages?: BaseMessage[] })?.messages ?? []
    )
      .filter((m) => !String(m.id).endsWith(":divider"))
      .map((m) => String(m.content));
  }

  test("a fallback that comes due with no append queued appends its message itself, with the same body", async () => {
    const { job, graphThreadId } = await armFallbackAndClaim(
      12601,
      820,
      "o dono não gravou",
    );
    // The deferring watcher's own claim, which stated it leaves the append: no statement that anyone
    // queued it.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ij-watcher-${process.pid}-820`,
        event: "message_created",
        conversationId: 990,
        inboundMessageId: 820,
        routeRemembers: false,
        status: "PROCESSED",
      },
    });
    // Armed, the fallback wrote no append of its own.
    expect(
      await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: ingestDedupeKey(graphThreadId, 820),
        },
      }),
    ).toBeNull();
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    expect(
      (await appendedTexts(saver, graphThreadId)).some((t) =>
        t.includes("o dono não gravou"),
      ),
    ).toBe(true);
  });

  test("a fallback that comes due beside the owner's queued append leaves that append as it was", async () => {
    const contactInboxId = 12602;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    // The owner's own append, with its own rendering of the message.
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 990,
      contactInboxId,
      graphThreadId,
      messageId: 821,
      text: "a transcrição do dono",
      role: "customer",
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    await suDb.schedulerJob.updateMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: ingestDedupeKey(graphThreadId, 821),
      },
      data: { runAt: new Date(Date.now() + 60 * 60_000) },
    });
    const { job } = await armFallbackAndClaim(
      contactInboxId,
      821,
      "[áudio não lido]",
    );
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    // Nothing of its own written either: the owner's queued append is the one that writes.
    expect(
      await appendedTexts(
        saver,
        contactInboxThreadId(tenantId, instanceId, 12602),
      ),
    ).toEqual([]);
    const rows = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: ingestDedupeKey(graphThreadId, 821),
      },
      select: { payload: true, payloadSecret: true },
    });
    expect(rows).toHaveLength(1);
    expect(decryptJson<string>(String(rows[0]?.payloadSecret))).toBe(
      "a transcrição do dono",
    );
    expect(
      (rows[0]?.payload as { agentId?: string } | undefined)?.agentId,
    ).toBe("1");
  });

  test("a later arm of a waiting fallback refreshes its body and leaves its run time as it was", async () => {
    const contactInboxId = 12603;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (text: string) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 990,
        contactInboxId,
        graphThreadId,
        messageId: 822,
        text,
        role: "customer",
        agentId: 2n,
        compactionEnabled: false,
        fallbackAfterMs: 10 * 60_000,
        base: appDb,
      });
    await arm("[áudio não lido]");
    const due = new Date(Date.now() + 60_000);
    await suDb.schedulerJob.updateMany({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        dedupeKey: ingestFallbackKey(graphThreadId, 822),
      },
      data: { runAt: due },
    });
    // The transcription arrives as an update while the fallback still waits.
    await arm("a transcrição que chegou depois");
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        dedupeKey: ingestFallbackKey(graphThreadId, 822),
      },
      select: { runAt: true, payloadSecret: true },
    });
    expect(row.runAt.getTime()).toBe(due.getTime());
    expect(decryptJson<string>(String(row.payloadSecret))).toBe(
      "a transcrição que chegou depois",
    );
  });

  // The barrier and the fallback. A fallback still waiting may be the thread's only copy of a
  // message, so compaction must not read past it; one whose time has come is folded in by the drain
  // itself, which with the shared scheduler off is the only thing that would ever run it.
  async function fallbackFixture(contactInboxId: number, messageId: number) {
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (fallbackAfterMs?: number) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 991,
        contactInboxId,
        graphThreadId,
        messageId,
        text: "a mensagem que só a reserva guarda",
        role: "customer",
        agentId: 1n,
        compactionEnabled: false,
        ...(fallbackAfterMs === undefined ? {} : { fallbackAfterMs }),
        base: appDb,
      });
    const synced = async () =>
      (
        await suDb.agentThread.findUnique({
          where: {
            tenantId_chatwootInstanceId_contactInboxId: {
              tenantId,
              chatwootInstanceId: instanceId,
              contactInboxId,
            },
          },
          select: { recentSyncedMessageIds: true },
        })
      )?.recentSyncedMessageIds ?? [];
    const fallbackLeft = () =>
      suDb.schedulerJob.count({
        where: {
          tenantId,
          kind: "INGEST_FALLBACK",
          dedupeKey: ingestFallbackKey(graphThreadId, messageId),
        },
      });
    return { graphThreadId, arm, synced, fallbackLeft };
  }

  test("a waiting fallback holds the barrier open, and is not run early", async () => {
    const f = await fallbackFixture(12604, 830);
    await f.arm(10 * 60_000);
    expect(await drainPendingIngest(tenantId, f.graphThreadId, appDb)).toBe(
      "incomplete",
    );
    expect(await f.synced()).toEqual([]);
    expect(await f.fallbackLeft()).toBe(1);
  });

  test("a fallback whose time has come is folded in by the drain", async () => {
    const f = await fallbackFixture(12605, 831);
    await f.arm(10 * 60_000);
    await suDb.schedulerJob.updateMany({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        dedupeKey: ingestFallbackKey(f.graphThreadId, 831),
      },
      data: { runAt: new Date(Date.now() - 1000) },
    });
    expect(await drainPendingIngest(tenantId, f.graphThreadId, appDb)).toBe(
      "drained",
    );
    expect(await f.synced()).toEqual([831]);
    expect(await f.fallbackLeft()).toBe(0);
  });

  test("the owner's append, once in memory, retires the fallback still waiting for it", async () => {
    const f = await fallbackFixture(12606, 832);
    await f.arm(10 * 60_000);
    await f.arm();
    expect(await drainPendingIngest(tenantId, f.graphThreadId, appDb)).toBe(
      "drained",
    );
    expect(await f.synced()).toEqual([832]);
    expect(await f.fallbackLeft()).toBe(0);
  });

  // The owner's statement on the ledger, which outlives the dedup window: a delivery that stated it
  // appends the message and settled, which it does only once the append is queued.
  async function ownerStatedAppend(conversationId: number, messageId: number) {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ij-owner-${process.pid}-${messageId}`,
        event: "message_updated",
        conversationId,
        inboundMessageId: messageId,
        routeRemembers: true,
        status: "PROCESSED",
      },
    });
  }

  test("a fallback that comes due for a message the owner queued writes nothing", async () => {
    const { job, graphThreadId } = await armFallbackAndClaim(
      12607,
      833,
      "o dono já gravou, a janela já esqueceu",
    );
    await ownerStatedAppend(990, 833);
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await appendedTexts(saver, graphThreadId)).toEqual([]);
  });

  test("a waiting fallback for a message the owner stated it appends does not hold the barrier", async () => {
    const f = await fallbackFixture(12608, 834);
    await f.arm(10 * 60_000);
    await ownerStatedAppend(991, 834);
    expect(await drainPendingIngest(tenantId, f.graphThreadId, appDb)).toBe(
      "drained",
    );
    expect(await f.fallbackLeft()).toBe(0);
    expect(await f.synced()).toEqual([]);
  });

  test("a later arm while the fallback is already claimed re-arms it with the newer text, and the claimed run stands down", async () => {
    const { job, graphThreadId } = await armFallbackAndClaim(
      12609,
      835,
      "[áudio não lido]",
    );
    // The transcription arrives while the claimed run has not appended yet.
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 990,
      contactInboxId: 12609,
      graphThreadId,
      messageId: 835,
      text: "a transcrição que chegou no meio",
      role: "customer",
      agentId: 2n,
      compactionEnabled: false,
      fallbackAfterMs: 10 * 60_000,
      base: appDb,
    });
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await appendedTexts(saver, graphThreadId)).toEqual([]);
    const again = (
      await claimDueTrafficJobs(50, appDb, new Date(), tenantId)
    ).find((j) => j.dedupeKey === ingestFallbackKey(graphThreadId, 835));
    if (!again) throw new Error("the re-armed fallback was not claimed");
    expect((await fallbackHandler(again, appDb, saver)).outcome).toBe("done");
    const texts = await appendedTexts(saver, graphThreadId);
    expect(
      texts.some((t) => t.includes("a transcrição que chegou no meio")),
    ).toBe(true);
    expect(texts.some((t) => t.includes("[áudio não lido]"))).toBe(false);
  });

  test("a later arm while the fallback is claimed re-arms nothing where the owner queued the message", async () => {
    const { graphThreadId } = await armFallbackAndClaim(
      12610,
      836,
      "[áudio não lido]",
    );
    await ownerStatedAppend(990, 836);
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 990,
      contactInboxId: 12610,
      graphThreadId,
      messageId: 836,
      text: "a transcrição deste watcher",
      role: "customer",
      agentId: 2n,
      compactionEnabled: false,
      fallbackAfterMs: 10 * 60_000,
      base: appDb,
    });
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        dedupeKey: ingestFallbackKey(graphThreadId, 836),
      },
      select: { status: true, payloadSecret: true },
    });
    expect(row.status).toBe("CLAIMED");
    expect(decryptJson<string>(String(row.payloadSecret))).toBe(
      "[áudio não lido]",
    );
  });

  test("an owner that stated it appends but never settled does not stand in for the fallback", async () => {
    const { job, graphThreadId } = await armFallbackAndClaim(
      12611,
      837,
      "o dono caiu antes de enfileirar",
    );
    // The flag is written just before the owner arms its append; a crash there leaves the row here.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ij-owner-crashed-${process.pid}-837`,
        event: "message_created",
        conversationId: 990,
        inboundMessageId: 837,
        routeRemembers: true,
        status: "PROCESSING",
      },
    });
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    expect(
      (await appendedTexts(saver, graphThreadId)).some((t) =>
        t.includes("o dono caiu antes de enfileirar"),
      ),
    ).toBe(true);
  });

  test("a newer message folded in brings an older waiting fallback due at once, and leaves a newer one waiting", async () => {
    const contactInboxId = 12612;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (messageId: number, fallbackAfterMs?: number) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 992,
        contactInboxId,
        graphThreadId,
        messageId,
        text: `mensagem ${messageId}`,
        role: "customer",
        agentId: 1n,
        compactionEnabled: false,
        ...(fallbackAfterMs === undefined ? {} : { fallbackAfterMs }),
        base: appDb,
      });
    await arm(840, 10 * 60_000);
    await arm(842, 10 * 60_000);
    await arm(841);
    const job = (
      await claimDueTrafficJobs(50, appDb, new Date(), tenantId)
    ).find((j) => j.dedupeKey === ingestDedupeKey(graphThreadId, 841));
    if (!job) throw new Error("the append was not claimed");
    expect((await ingestHandler(job, appDb, new MemorySaver())).outcome).toBe(
      "done",
    );
    const runAt = async (messageId: number) =>
      (
        await suDb.schedulerJob.findFirstOrThrow({
          where: {
            tenantId,
            kind: "INGEST_FALLBACK",
            dedupeKey: ingestFallbackKey(graphThreadId, messageId),
          },
          select: { runAt: true },
        })
      ).runAt.getTime();
    expect(await runAt(840)).toBeLessThanOrEqual(Date.now());
    expect(await runAt(842)).toBeGreaterThan(Date.now() + 60_000);
  });

  // With the shared scheduler off, the barrier is the only thing that runs either kind. More newer
  // appends queued than the dedup window holds must not push a waiting fallback's message out of it.
  test("a barrier draining more newer appends than the dedup window holds still folds in the older fallback", async () => {
    const contactInboxId = 12613;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (messageId: number, sentAt: Date, fallbackAfterMs?: number) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 993,
        contactInboxId,
        graphThreadId,
        messageId,
        text: `mensagem ${messageId}`,
        role: "customer",
        sentAt,
        agentId: 1n,
        compactionEnabled: false,
        ...(fallbackAfterMs === undefined ? {} : { fallbackAfterMs }),
        base: appDb,
      });
    const t0 = Date.now() - 60 * 60_000;
    await arm(1000, new Date(t0), 10 * 60_000);
    for (let i = 1; i <= INGEST_ID_WINDOW + 6; i++)
      await arm(1000 + i, new Date(t0 + i * 1000));
    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "drained",
    );
    const saved = await (await getCheckpointer()).get({
      configurable: { thread_id: graphThreadId },
    });
    const ids = (
      (saved?.channel_values as { messages?: BaseMessage[] })?.messages ?? []
    ).map((m) => m.id);
    expect(ids).toContain("ingest:1000");
    expect(ids).toHaveLength(INGEST_ID_WINDOW + 7);
  }, 180_000);

  test("a barrier draining more newer appends than the dedup window holds still folds in an older fallback with no send time", async () => {
    const contactInboxId = 12614;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (
      messageId: number,
      sentAt: Date | null,
      fallbackAfterMs?: number,
    ) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 994,
        contactInboxId,
        graphThreadId,
        messageId,
        text: `mensagem ${messageId}`,
        role: "customer",
        ...(sentAt === null ? {} : { sentAt }),
        agentId: 1n,
        compactionEnabled: false,
        ...(fallbackAfterMs === undefined ? {} : { fallbackAfterMs }),
        base: appDb,
      });
    const t0 = Date.now() - 60 * 60_000;
    await arm(1000, null, 10 * 60_000);
    for (let i = 1; i <= INGEST_ID_WINDOW + 6; i++)
      await arm(1000 + i, new Date(t0 + i * 1000));
    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "drained",
    );
    const saved = await (await getCheckpointer()).get({
      configurable: { thread_id: graphThreadId },
    });
    const ids = (
      (saved?.channel_values as { messages?: BaseMessage[] })?.messages ?? []
    ).map((m) => m.id);
    expect(ids).toContain("ingest:1000");
    expect(ids).toHaveLength(INGEST_ID_WINDOW + 7);
  }, 180_000);

  // The shared tick claims by rank and creation, not by run time. A fallback appends in its own run,
  // so its row, created when the message arrived, is reached before the newer appends queued after it.
  test("the shared tick draining more newer appends than the dedup window holds still folds in the older fallback", async () => {
    const contactInboxId = 12615;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (messageId: number, fallbackAfterMs?: number) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 995,
        contactInboxId,
        graphThreadId,
        messageId,
        text: `mensagem ${messageId}`,
        role: "customer",
        agentId: 1n,
        compactionEnabled: false,
        ...(fallbackAfterMs === undefined ? {} : { fallbackAfterMs }),
        base: appDb,
      });
    await arm(3000, 10 * 60_000);
    for (let i = 1; i <= INGEST_ID_WINDOW + 6; i++) await arm(3000 + i);
    const ours = (key: string) =>
      key.startsWith(ingestKeyPrefix(graphThreadId)) ||
      key.startsWith(ingestFallbackKeyPrefix(graphThreadId));
    const saver = new MemorySaver();
    for (let tick = 0; tick < 20; tick++) {
      // The claim is tenant-wide, and earlier cases leave rows of their own: stop on an empty claim,
      // not on one with nothing of this thread in it.
      const all = await claimDueTrafficJobs(50, appDb, new Date(), tenantId);
      if (all.length === 0) break;
      const claimed = all.filter((j) => ours(j.dedupeKey ?? ""));
      for (const job of claimed) {
        if (job.kind === "INGEST_FALLBACK")
          await fallbackHandler(job, appDb, saver);
        else await ingestHandler(job, appDb, saver);
      }
    }
    const saved = await saver.get({
      configurable: { thread_id: graphThreadId },
    });
    const ids = (
      (saved?.channel_values as { messages?: BaseMessage[] })?.messages ?? []
    ).map((m) => m.id);
    expect(ids).toContain("ingest:3000");
  }, 180_000);

  test("a barrier with more due fallbacks than one batch folds them all in before the newer appends move on", async () => {
    const contactInboxId = 12616;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (messageId: number, fallbackAfterMs?: number) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 996,
        contactInboxId,
        graphThreadId,
        messageId,
        text: `mensagem ${messageId}`,
        role: "customer",
        agentId: 1n,
        compactionEnabled: false,
        ...(fallbackAfterMs === undefined ? {} : { fallbackAfterMs }),
        base: appDb,
      });
    for (let i = 0; i < 60; i++) await arm(4000 + i, 10 * 60_000);
    for (let i = 0; i < INGEST_ID_WINDOW + 6; i++) await arm(4100 + i);
    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "drained",
    );
    const saved = await (await getCheckpointer()).get({
      configurable: { thread_id: graphThreadId },
    });
    const ids = new Set(
      (
        (saved?.channel_values as { messages?: BaseMessage[] })?.messages ?? []
      ).map((m) => m.id),
    );
    const missing = Array.from(
      { length: 60 },
      (_, i) => `ingest:${4000 + i}`,
    ).filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  }, 180_000);

  // The fallbacks come due with their run times in the OPPOSITE order of their ids, and each claimed
  // batch comes back reversed, as `UPDATE ... RETURNING` is free to. The window starts with 50 ids, so
  // 14 free slots decide it: run by run time, everything after the first 14 falls below the floor;
  // sorted only within a batch of 50, the ten oldest land in the second batch, below the floor the
  // first one moved. The ids are read in the order they were folded in.
  test("due fallbacks across more than one batch are folded in by message id, not by run time", async () => {
    const contactInboxId = 12640;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (messageId: number, fallbackAfterMs?: number) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 997,
        contactInboxId,
        graphThreadId,
        messageId,
        text: `mensagem ${messageId}`,
        role: "customer",
        agentId: 1n,
        compactionEnabled: false,
        ...(fallbackAfterMs === undefined ? {} : { fallbackAfterMs }),
        base: appDb,
      });
    for (let i = 0; i < 50; i++) await arm(6100 + i);
    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "drained",
    );
    for (let i = 59; i >= 0; i--) await arm(6000 + i, 10 * 60_000);
    const longAgo = Date.now() - 3_600_000;
    for (let i = 0; i < 60; i++)
      await suDb.schedulerJob.updateMany({
        where: {
          tenantId,
          kind: "INGEST_FALLBACK",
          dedupeKey: ingestFallbackKey(graphThreadId, 6000 + i),
        },
        data: { runAt: new Date(longAgo - i * 1000) },
      });
    const claimDue = scheduler.claimDueByKeyPrefix;
    const reversed = spyOn(scheduler, "claimDueByKeyPrefix").mockImplementation(
      async (...args) => (await claimDue(...args)).reverse(),
    );
    try {
      expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
        "drained",
      );
    } finally {
      reversed.mockRestore();
    }
    const saved = await (await getCheckpointer()).get({
      configurable: { thread_id: graphThreadId },
    });
    const ids = (
      (saved?.channel_values as { messages?: BaseMessage[] })?.messages ?? []
    )
      .map((m) => m.id ?? "")
      .filter((id) => /^ingest:60\d\d$/.test(id));
    expect(ids).toEqual(
      Array.from({ length: 60 }, (_, i) => `ingest:${6000 + i}`),
    );
  }, 180_000);

  test("a fallback the owner covered, for a message already below the window's floor, stands down without reporting a lost append", async () => {
    const contactInboxId = 12617;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    for (let i = 1; i <= INGEST_ID_WINDOW + 6; i++)
      await armIngest({
        tenantId,
        instanceId,
        conversationId: 990,
        contactInboxId,
        graphThreadId,
        messageId: 5000 + i,
        text: `mensagem ${5000 + i}`,
        role: "customer",
        agentId: 1n,
        compactionEnabled: false,
        base: appDb,
      });
    expect(await drainPendingIngest(tenantId, graphThreadId, appDb)).toBe(
      "drained",
    );
    const { job } = await armFallbackAndClaim(
      contactInboxId,
      5000,
      "o dono gravou esta há muito tempo",
    );
    await ownerStatedAppend(990, 5000);
    expect((await fallbackHandler(job, appDb)).outcome).toBe("done");
    const undecidable = (
      await flowLogRows(suDb, {
        // flowlog-scope: tenant-wide. The line names the message in its detail.
        where: { tenantId, stage: "memory" },
      })
    ).filter((l) => {
      const detail = JSON.stringify(l.detail ?? {});
      return (
        detail.includes("ingest_append_undecidable") &&
        detail.includes(`"messageId":5000,`)
      );
    });
    expect(undecidable).toEqual([]);
  }, 180_000);

  test("a newer message folded in leaves a fallback in failure backoff at its retry time", async () => {
    const contactInboxId = 12618;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (messageId: number, fallbackAfterMs?: number) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 997,
        contactInboxId,
        graphThreadId,
        messageId,
        text: `mensagem ${messageId}`,
        role: "customer",
        agentId: 1n,
        compactionEnabled: false,
        ...(fallbackAfterMs === undefined ? {} : { fallbackAfterMs }),
        base: appDb,
      });
    await arm(6000, 10 * 60_000);
    const retryAt = new Date(Date.now() + 5 * 60_000);
    await suDb.schedulerJob.updateMany({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        dedupeKey: ingestFallbackKey(graphThreadId, 6000),
      },
      data: { runAt: retryAt, attempts: 1 },
    });
    await arm(6001);
    const job = (
      await claimDueTrafficJobs(50, appDb, new Date(), tenantId)
    ).find((j) => j.dedupeKey === ingestDedupeKey(graphThreadId, 6001));
    if (!job) throw new Error("the append was not claimed");
    expect((await ingestHandler(job, appDb, new MemorySaver())).outcome).toBe(
      "done",
    );
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        dedupeKey: ingestFallbackKey(graphThreadId, 6000),
      },
      select: { runAt: true },
    });
    expect(row.runAt.getTime()).toBe(retryAt.getTime());
  });

  test("an owner's creation settled with nothing to append does not stand in for a fallback armed by the update that brought the audio", async () => {
    const contactInboxId = 12620;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 998,
      contactInboxId,
      graphThreadId,
      messageId: 839,
      text: "a transcrição do áudio anexado depois",
      role: "customer",
      agentId: 2n,
      compactionEnabled: false,
      fallbackAfterMs: 10 * 60_000,
      event: "message_updated",
      base: appDb,
    });
    // The owner settled the empty creation; its update delivery never came.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ij-owner-empty-${process.pid}-839`,
        event: "message_created",
        conversationId: 998,
        inboundMessageId: 839,
        routeRemembers: true,
        status: "PROCESSED",
      },
    });
    const job = (
      await claimDueTrafficJobs(
        50,
        appDb,
        new Date(Date.now() + 11 * 60_000),
        tenantId,
      )
    ).find((j) => j.dedupeKey === ingestFallbackKey(graphThreadId, 839));
    if (!job) throw new Error("the fallback was not claimed once due");
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    expect(
      (await appendedTexts(saver, graphThreadId)).some((t) =>
        t.includes("a transcrição do áudio anexado depois"),
      ),
    ).toBe(true);
  });

  // Two `message_updated` of one voice note, each delivered on both routes: the first carried no words
  // and the owner settled it remembering, the second carried them. `ownerSettled` says how many of the
  // owner's two it settled; the watcher settled both, the second by arming the fallback.
  async function twoUpdatesFallback(
    contactInboxId: number,
    messageId: number,
    text: string,
    ownerSettled: 1 | 2,
  ) {
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 999,
      contactInboxId,
      graphThreadId,
      messageId,
      text,
      role: "customer",
      agentId: 2n,
      compactionEnabled: false,
      fallbackAfterMs: 10 * 60_000,
      event: "message_updated",
      routes: { owner: 71, watcher: 72 },
      base: appDb,
    });
    for (const [n, route, settled] of [
      [1, 71, true],
      [2, 71, ownerSettled === 2],
      [1, 72, true],
      [2, 72, true],
    ] as const) {
      await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `ij-upd-${process.pid}-${messageId}-${route}-${n}`,
          event: "message_updated",
          conversationId: 999,
          inboundMessageId: messageId,
          routeAgentBotId: route,
          routeRemembers: route === 71 ? (settled ? true : null) : false,
          status: settled ? "PROCESSED" : "PENDING",
        },
      });
    }
    const job = (
      await claimDueTrafficJobs(
        50,
        appDb,
        new Date(Date.now() + 11 * 60_000),
        tenantId,
      )
    ).find((j) => j.dedupeKey === ingestFallbackKey(graphThreadId, messageId));
    if (!job) throw new Error("the fallback was not claimed once due");
    return { job, graphThreadId };
  }

  test("an owner's earlier update settled with nothing to append does not stand in for the later update that brought the words", async () => {
    const { job, graphThreadId } = await twoUpdatesFallback(
      12631,
      851,
      "as palavras do segundo update",
      1,
    );
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    expect(
      (await appendedTexts(saver, graphThreadId)).some((t) =>
        t.includes("as palavras do segundo update"),
      ),
    ).toBe(true);
  });

  test("with neither route's delivery in the ledger, a fallback that names its routes appends its message", async () => {
    const contactInboxId = 12633;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    await armIngest({
      tenantId,
      instanceId,
      conversationId: 999,
      contactInboxId,
      graphThreadId,
      messageId: 853,
      text: "nenhuma entrega registrada",
      role: "customer",
      agentId: 2n,
      compactionEnabled: false,
      fallbackAfterMs: 10 * 60_000,
      event: "message_updated",
      routes: { owner: 71, watcher: 72 },
      base: appDb,
    });
    const job = (
      await claimDueTrafficJobs(
        50,
        appDb,
        new Date(Date.now() + 11 * 60_000),
        tenantId,
      )
    ).find((j) => j.dedupeKey === ingestFallbackKey(graphThreadId, 853));
    if (!job) throw new Error("the fallback was not claimed once due");
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    expect(
      (await appendedTexts(saver, graphThreadId)).some((t) =>
        t.includes("nenhuma entrega registrada"),
      ),
    ).toBe(true);
  });

  test("an owner that settled every update this route received stands in for the fallback", async () => {
    const { job, graphThreadId } = await twoUpdatesFallback(
      12632,
      852,
      "o dono já gravou as duas",
      2,
    );
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, appDb, saver)).outcome).toBe("done");
    expect(await appendedTexts(saver, graphThreadId)).toEqual([]);
  });

  // A client that runs `before` ahead of every call on one model, inside transactions too, so a test
  // can land a concurrent write at the exact point a function reads.
  function onModel(
    real: PrismaClient,
    model: string,
    before: () => Promise<void>,
  ): PrismaClient {
    const wrap = (c: Record<string, unknown>): never =>
      new Proxy(c, {
        get(t, p: string) {
          if (p === "$transaction")
            return (fn: unknown, opts?: unknown) =>
              typeof fn === "function"
                ? (t.$transaction as (f: unknown, o?: unknown) => unknown).call(
                    t,
                    (tx: Record<string, unknown>) =>
                      (fn as (x: unknown) => unknown)(wrap(tx)),
                    opts,
                  )
                : (t.$transaction as (f: unknown, o?: unknown) => unknown).call(
                    t,
                    fn,
                    opts,
                  );
          if (p === "$extends")
            return (...a: unknown[]) =>
              wrap(
                (
                  t.$extends as (...x: unknown[]) => Record<string, unknown>
                ).apply(t, a),
              );
          const v = Reflect.get(t, p);
          if (p === model && v && typeof v === "object")
            return new Proxy(v as Record<string, unknown>, {
              get(d, op: string) {
                const f = Reflect.get(d, op);
                if (typeof f !== "function") return f;
                return async (...a: unknown[]) => {
                  await before();
                  return (f as (...x: unknown[]) => unknown).apply(d, a);
                };
              },
            });
          return typeof v === "function"
            ? (v as (...x: unknown[]) => unknown).bind(t)
            : v;
        },
      }) as never;
    return wrap(real as unknown as Record<string, unknown>);
  }

  test("a fallback refreshed while the barrier asks the ledger about its older body is not retired", async () => {
    const contactInboxId = 12621;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const arm = (text: string, event: string) =>
      armIngest({
        tenantId,
        instanceId,
        conversationId: 999,
        contactInboxId,
        graphThreadId,
        messageId: 840,
        text,
        role: "customer",
        agentId: 2n,
        compactionEnabled: false,
        fallbackAfterMs: 10 * 60_000,
        event,
        base: appDb,
      });
    await arm("[áudio não lido]", "message_created");
    // The owner settled the creation; the update that brings the words has no owner delivery.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `ij-owner-creation-${process.pid}-840`,
        event: "message_created",
        conversationId: 999,
        inboundMessageId: 840,
        routeRemembers: true,
        status: "PROCESSED",
      },
    });
    let refreshed = false;
    const racing = onModel(appDb, "chatwootWebhookDelivery", async () => {
      if (refreshed) return;
      refreshed = true;
      await arm("as palavras que chegaram no update", "message_updated");
    });
    await retireCoveredFallbacks(tenantId, graphThreadId, racing);
    const row = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "INGEST_FALLBACK",
        dedupeKey: ingestFallbackKey(graphThreadId, 840),
      },
      select: { payloadSecret: true },
    });
    expect(refreshed).toBe(true);
    expect(row).not.toBeNull();
    expect(decryptJson<string>(String(row?.payloadSecret))).toBe(
      "as palavras que chegaram no update",
    );
  });

  test("a fallback asks whether the owner queued its message once it holds the thread, not before", async () => {
    const { job, graphThreadId } = await armFallbackAndClaim(
      12622,
      841,
      "o dono enfileirou enquanto a reserva esperava a vez",
    );
    // The owner's delivery settles exactly when the fallback's append re-reads its own claim, inside
    // the critical section: a check made before entering it would have missed it.
    let settled = false;
    const racing = onModel(appDb, "schedulerJob", async () => {
      if (settled) return;
      settled = true;
      await ownerStatedAppend(990, 841);
    });
    const saver = new MemorySaver();
    expect((await fallbackHandler(job, racing, saver)).outcome).toBe("done");
    expect(settled).toBe(true);
    expect(await appendedTexts(saver, graphThreadId)).toEqual([]);
  });
});

// What the drain's sort does with a payload the claim's SQL also has to rank: a missing or non-numeric
// id goes last, and equal ids keep the row order.
describe("a claimed batch of fallbacks runs in message id order", () => {
  test("lowest id first, a row without a numeric id last, ties by row", () => {
    const job = (id: bigint, messageId: unknown): ClaimedJob => ({
      id,
      tenantId: 1n,
      kind: "INGEST_FALLBACK",
      payload: { messageId },
      attempts: 0,
      claimSeq: 1,
    });
    const batch = [
      job(1n, 7002),
      job(2n, "7000"),
      job(3n, 7000),
      job(4n, 6999),
      job(5n, 7001),
      job(6n, undefined),
      job(7n, 7000),
    ];
    expect(batch.sort(byMessageId).map((j) => j.id)).toEqual([
      4n,
      3n,
      7n,
      5n,
      1n,
      2n,
      6n,
    ]);
  });
});
