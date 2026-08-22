import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import { drainPendingIngest } from "@/graph/ingest-drain";
import { armIngest, ingestHandler } from "@/graph/ingest-job";
import { type ClaimedJob, claimDueJobs } from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #194, hazard 1, and the reason continuous ingestion became a job at all.
//
// A LangGraph invoke is a read-modify-write of the WHOLE message channel, so a message appended
// beside a running turn is undone when that turn saves. On the inline path the append happened
// anyway and the thread's own record advanced with it, which is what made the loss permanent: the
// message was gone AND marked handled. What the job buys is a third answer — put it down, come back.

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
  } catch {
    dbUp = false;
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

  test("the message is not appended while a turn owns the thread, and is not lost", async () => {
    const saver = new MemorySaver();
    const contactInboxId = 12501;
    const graphThreadId = contactInboxThreadId(
      tenantId,
      instanceId,
      contactInboxId,
    );
    const job: ClaimedJob = {
      id: 1n,
      tenantId,
      kind: "INGEST_MESSAGE",
      attempts: 0,
      claimSeq: 1,
      payload: {
        instanceId: String(instanceId),
        conversationId: 980,
        contactInboxId,
        graphThreadId,
        messageId: 300,
        text: encryptJson("e o orçamento, saiu?"),
        role: "customer",
        agentId: "1",
        compactionEnabled: false,
      },
    };
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

    // The observable half. Nothing was appended, and — the part that made the inline loss permanent
    // — the thread has no record claiming this message was handled, so the retry still ingests it.
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

  // The dedupe key, which a mutation run caught as an untested rule. `enqueueJob` keeps ONE live row
  // per (tenant, kind, dedupeKey) and a re-enqueue REPLACES the payload, so a key scoped to the
  // thread would let the second message of a burst overwrite the first before either ran — the same
  // message loss this job exists to stop, moved one layer out and much harder to see, because the
  // thread would look healthy and only one of the two messages would ever have existed as work.
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

    const claimed = await claimDueJobs(50, appDb, new Date(), tenantId);
    const texts = claimed
      .filter((j) => j.kind === "INGEST_MESSAGE")
      .map((j) => decryptJson<string>(String(j.payload.text)));
    expect(texts.sort()).toEqual(["primeira da rajada", "segunda da rajada"]);
    for (const job of claimed) await runClaimed(job, appDb);
  });

  // THE BARRIER (round 2 review). Queuing the append cost synchronous ordering: a turn can start
  // while a message meant for its context is still a row, and answer without it. The turn drains its
  // own thread first, and the subtle half is that the drain ignores `run_at` — a job DEFERRED for a
  // previous turn sits a minute in the future, and those are exactly the messages a starting turn is
  // missing. A drain that only took due rows would skip them and look correct doing it.
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
      (await claimDueJobs(50, appDb, new Date(), tenantId)).filter(
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
    const left = await suDb.schedulerJob.count({
      where: { tenantId, kind: "INGEST_MESSAGE" },
    });
    expect(left).toBe(0);
  });

  // Round-8 review finding (P2). A CLAIMED row counts as OWED, which is what lets compaction refuse
  // to summarise an attendance whose messages are still coming — and it is also how one crash turns
  // into a permanent stall. Ingestion has no tick of its own: these readers are its only path, and
  // the drain claims PENDING rows only, so a row left CLAIMED by a process that died mid-job is
  // invisible to the drain and owed forever. Every later compaction on that thread would reschedule
  // and never run again.
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
    const job: ClaimedJob = {
      id: 2n,
      tenantId,
      kind: "INGEST_MESSAGE",
      attempts: 0,
      claimSeq: 1,
      payload: {
        instanceId: String(instanceId),
        conversationId: 981,
        contactInboxId,
        graphThreadId,
        messageId: 301,
        text: encryptJson("ainda estou aqui"),
        role: "customer",
        agentId: "1",
        compactionEnabled: false,
      },
    };

    markTurnInFlight(graphThreadId);
    markTurnInFlight(graphThreadId);
    clearTurnInFlight(graphThreadId);
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("reschedule");

    clearTurnInFlight(graphThreadId);
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
  });
});
