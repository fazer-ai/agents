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
import { runScopedOn } from "@/lib/tenancy";
import {
  type ClaimedJob,
  claimDueJobs,
  revokeJobsByKeyPrefixOn,
} from "@/modules/scheduler/service";
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

  // A REAL row, claimed the way the tick claims it, rather than a hand-built `ClaimedJob`. The
  // handler now re-reads its own row under the lock to see whether it was revoked while it waited
  // (a /reset does exactly that), so a synthetic job with no row behind it is a job that has already
  // been cancelled — and every test built that way would pass for the wrong reason.
  async function armAndClaim(
    contactInboxId: number,
    conversationId: number,
    messageId: number,
    text: string,
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
      agentId: 1n,
      compactionEnabled: false,
      base: appDb,
    });
    const claimed = (
      await claimDueJobs(50, appDb, new Date(), tenantId)
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

  // Round-11 review finding (P2). `encryptJson` returns a base64 blob and this repository's rule is
  // that such a blob lives in a plain String column, never in a Prisma `Json` one: a Json payload is
  // what gets logged or serialized whole, and it would carry a contact's own words with it. The
  // ciphertext therefore has its own column, and what stays in the JSON must be metadata only.
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

  // Round-9 review finding (P1). /reset clears this thread's summaries, its AgentThread row and its
  // checkpoint, all under the `ingest:<thread>` lock — and it cancels the pending COMPACTION job,
  // because that is the only queued writer of this memory it knew about. Continuous ingestion is one
  // now, and the worst shape of it is a job already CLAIMED and blocked on that very lock: it lands
  // the instant the reset releases and rebuilds the thread from text the operator was told had been
  // cleared, with the reset reported as successful.
  //
  // Staged the way it actually happens: the job is claimed FIRST (it is in memory, past every check
  // a cancellation could reach), and the revocation runs while it waits.
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

  // The other half of that fence, which a mutation run caught as untested: `claimSeq`, not just the
  // status. A duplicate delivery re-arms the row back to PENDING without touching claimSeq, so the
  // status alone covers that — but the tick can then CLAIM it again, which bumps the sequence and
  // starts a second run while the first is still waiting on the thread lock. Two runs of one key at
  // once is what the scheduler avoids everywhere else; here the first one stands down and the row
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
    const second = (await claimDueJobs(50, appDb, new Date(), tenantId)).find(
      (j) => j.id === first.id,
    );
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
    // Read from the dedicated column, not from the JSON: the ciphertext of a contact's own words
    // does not live in `payload` (CLAUDE.md, Encryption).
    const texts = claimed
      .filter((j) => j.kind === "INGEST_MESSAGE")
      .map((j) => decryptJson<string>(String(j.payloadSecret)));
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
    const job = await armAndClaim(contactInboxId, 981, 301, "ainda estou aqui");

    markTurnInFlight(graphThreadId);
    markTurnInFlight(graphThreadId);
    clearTurnInFlight(graphThreadId);
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("reschedule");

    clearTurnInFlight(graphThreadId);
    expect((await ingestHandler(job, appDb, saver)).outcome).toBe("done");
  });
});
