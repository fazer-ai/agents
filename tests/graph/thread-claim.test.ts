import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import {
  claimIngestWrite,
  clearTurnOwning,
  markTurnOwning,
  releaseIngestWrite,
  type ThreadOwner,
  threadBusyForResetOn,
  turnOwnsThread,
} from "@/graph/thread-claim";
import { runScopedOn } from "@/lib/tenancy";
import { sysCtx } from "@/modules/documents/issue";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #203. The in-process registry cannot see a turn running on another replica, so the claim it
// answers with has to live in a row. What is asserted here is the ROW's behaviour, read back with a
// second client, the closest a single process gets to being two of them, and enough for every rule
// this module states, because every one of them is a predicate Postgres evaluates.

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

describe.skipIf(!dbUp)("the durable turn claim on a thread", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TC", slug: `tc-${process.pid}` },
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
      for (const table of ["agent_threads", "chatwoot_instances"]) {
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

  // One contact inbox per test: the module short-circuits on the in-process Map, so a key another
  // test marked would answer "held" without the row being asked at all.
  let nextInbox = 77_000;
  function owner(): ThreadOwner {
    const contactInboxId = nextInbox++;
    return {
      tenantId,
      instanceId,
      contactInboxId,
      graphThreadId: contactInboxThreadId(tenantId, instanceId, contactInboxId),
    };
  }

  async function rowOf(o: ThreadOwner) {
    return suDb.agentThread.findUniqueOrThrow({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: o.contactInboxId,
        },
      },
      select: {
        turnHolders: true,
        turnHeldUntil: true,
        ingestWriteUntil: true,
      },
    });
  }

  test("a turn takes the thread on a row that does not exist yet", async () => {
    const o = owner();
    await markTurnOwning(o, appDb);
    const row = await rowOf(o);
    expect(row.turnHolders).toBe(1);
    expect(row.turnHeldUntil).not.toBeNull();
    expect(await turnOwnsThread(o, appDb)).toBe(true);
  });

  test("the hold is counted, so an overlapping turn keeps it", async () => {
    const o = owner();
    const first = await markTurnOwning(o, appDb);
    const second = await markTurnOwning(o, appDb);
    // Both joined the SAME occupancy, so both releases match.
    expect(second.epoch).toBe(first.epoch);
    expect((await rowOf(o)).turnHolders).toBe(2);
    await clearTurnOwning(o, appDb, first);
    // The first turn finished; the second is still reading the channel.
    expect((await rowOf(o)).turnHolders).toBe(1);
    expect((await rowOf(o)).turnHeldUntil).not.toBeNull();
    await clearTurnOwning(o, appDb, second);
    const row = await rowOf(o);
    expect(row.turnHolders).toBe(0);
    expect(row.turnHeldUntil).toBeNull();
  });

  test("an expired hold reads free, and the next turn repairs the count", async () => {
    const o = owner();
    // ANOTHER process took the thread twice and died: what it leaves behind is the row and nothing
    // else, so the hold is seeded the way that process would have left it. Marking through the
    // module here instead would also mark THIS process's Map, and a Map entry is not what a dead
    // replica leaves, it would be asserting against a claim that is genuinely still live.
    await suDb.$executeRawUnsafe(
      `INSERT INTO agent_threads
         (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id,
          turn_holders, turn_held_until, created_at, updated_at)
       VALUES (${tenantId}, ${instanceId}, ${o.contactInboxId}, '${o.graphThreadId}',
          2, now() - interval '1 second', now(), now())`,
    );
    const stale = await claimIngestWrite(o, appDb);
    expect(stale.state).toBe("claimed");
    await releaseIngestWrite(o, appDb, stale);
    // A count left at 2 by the dead process would keep the thread held for a whole lease after the
    // next turn released once. The repair is what stops that leaking forever.
    const repaired = await markTurnOwning(o, appDb);
    expect((await rowOf(o)).turnHolders).toBe(1);
    await clearTurnOwning(o, appDb, repaired);
    expect((await rowOf(o)).turnHolders).toBe(0);
  });

  // The whole point, in one assertion: a hold this process never took is still a hold. Seeded as a
  // row and nothing else, because that is all another replica leaves behind.
  test("a hold taken by another process is visible here", async () => {
    const o = owner();
    await suDb.$executeRawUnsafe(
      `INSERT INTO agent_threads
         (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id,
          turn_holders, turn_held_until, created_at, updated_at)
       VALUES (${tenantId}, ${instanceId}, ${o.contactInboxId}, '${o.graphThreadId}',
          1, now() + interval '5 minutes', now(), now())`,
    );
    expect(await turnOwnsThread(o, appDb)).toBe(true);
    await suDb.$executeRawUnsafe(
      `UPDATE agent_threads SET turn_held_until = now() - interval '1 second'
        WHERE tenant_id = ${tenantId} AND contact_inbox_id = ${o.contactInboxId}`,
    );
    // The lease, and the reason it is not optional: without it the dead replica's hold would fence
    // this thread forever, which is worse than the registry it replaces.
    expect(await turnOwnsThread(o, appDb)).toBe(false);
  });

  // AN UNREADABLE CLAIM IS A HELD ONE. What this replaced was a Map lookup that could not fail, and
  // every caller uses the false to ACT: /reset takes a conversation off a human with it, compaction
  // rewrites the channel with it, ingestion writes the divider with it. A rejected read reaching any
  // of them as `false` is worse than the registry this module replaces, because the registry never
  // produced one.
  //
  // Asserted on the client-level read, not on a stubbed helper: what has to hold is that the
  // rejection cannot escape this function at all.
  test("a claim that cannot be read counts as held", async () => {
    const o = owner();
    // No holder in the row, so the true below can only come from the failure.
    expect(await turnOwnsThread(o, appDb)).toBe(false);
    const blind = appDb.$extends({
      query: {
        async $allOperations({ operation, args, query }) {
          if (operation === "$queryRaw" || operation === "$queryRawUnsafe") {
            throw new Error("connection reset");
          }
          return query(args);
        },
      },
    }) as unknown as PrismaClient;
    expect(await turnOwnsThread(o, blind)).toBe(true);
  });

  test("an append stands down while a turn owns the thread", async () => {
    const o = owner();
    const hold = await markTurnOwning(o, appDb);
    expect((await claimIngestWrite(o, appDb)).state).toBe("busy");
    await clearTurnOwning(o, appDb, hold);
    expect((await claimIngestWrite(o, appDb)).state).toBe("claimed");
  });

  // A thread with NO ROW is claimed by CREATING one, which is what makes the first message on a
  // thread as protected as every later one.
  test("a second append stands down while the first holds the write", async () => {
    const o = owner();
    const created = await claimIngestWrite(o, appDb);
    expect(created.state).toBe("created");
    expect((await claimIngestWrite(o, appDb)).state).toBe("busy");
    await releaseIngestWrite(o, appDb, created);
    const hold = await markTurnOwning(o, appDb);
    await clearTurnOwning(o, appDb, hold);
    const first = await claimIngestWrite(o, appDb);
    expect(first.state).toBe("claimed");
    expect((await claimIngestWrite(o, appDb)).state).toBe("busy");
    await releaseIngestWrite(o, appDb, first);
    expect((await claimIngestWrite(o, appDb)).state).toBe("claimed");
  });

  // The row a `/reset` just deleted must not come back through a claim: rebuilding it is the write
  // the revoked job is forbidden to make (tests/graph/ingest-job.test.ts pins the same rule end to
  // end). The claim now CREATES a row to hold, so the rule moves to the release: an append that
  // wrote nothing leaves nothing. Asserted on the ROW COUNT, because "the call returned" and "the
  // database is as it was" are two different claims.
  test("an append that writes nothing leaves no row behind", async () => {
    const o = owner();
    const created = await claimIngestWrite(o, appDb);
    expect(created.state).toBe("created");
    const held = await suDb.agentThread.count({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId: o.contactInboxId,
      },
    });
    expect(held).toBe(1);
    await releaseIngestWrite(o, appDb, created);
    expect(
      await suDb.agentThread.count({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: o.contactInboxId,
        },
      }),
    ).toBe(0);
  });

  // The other half of the same rule: a row the claim created and the append then WROTE to is the
  // thread's real row, and release must leave it alone.
  test("a row the append wrote to survives the release", async () => {
    const o = owner();
    const created = await claimIngestWrite(o, appDb);
    expect(created.state).toBe("created");
    await suDb.agentThread.updateMany({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId: o.contactInboxId,
      },
      data: { lastSyncedMessageId: 4242 },
    });
    await releaseIngestWrite(o, appDb, created);
    const row = await suDb.agentThread.findFirst({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        contactInboxId: o.contactInboxId,
      },
      select: { lastSyncedMessageId: true, ingestWriteUntil: true },
    });
    expect(row?.lastSyncedMessageId).toBe(4242);
    expect(row?.ingestWriteUntil).toBeNull();
  });

  // A LEASE THAT EXPIRED UNDER A SLOW HOLDER IS NOT THE SAME CLAIM. The holder is still running and
  // still reaches its release; without a discriminator that release decrements a count belonging to
  // whoever took the thread next, zeroes it, and opens the thread to an append the newer invoke goes
  // on to erase. Which is the loss this whole module exists to stop, reintroduced by the cleanup.
  test("a release from an expired hold does not free the turn that replaced it", async () => {
    const o = owner();
    const slow = await markTurnOwning(o, appDb);
    // The lease runs out while that turn is still working.
    await suDb.$executeRawUnsafe(
      `UPDATE agent_threads SET turn_held_until = now() - interval '1 second'
        WHERE tenant_id = ${tenantId} AND contact_inbox_id = ${o.contactInboxId}`,
    );
    const next = await markTurnOwning(o, appDb);
    expect(next.epoch).not.toBe(slow.epoch);
    expect((await rowOf(o)).turnHolders).toBe(1);
    // The slow turn finishes and releases what it took.
    await clearTurnOwning(o, appDb, slow);
    const row = await rowOf(o);
    expect(row.turnHolders).toBe(1);
    expect(row.turnHeldUntil).not.toBeNull();
    expect(await turnOwnsThread(o, appDb)).toBe(true);
    await clearTurnOwning(o, appDb, next);
    expect((await rowOf(o)).turnHolders).toBe(0);
  });

  // The same question on the append side, where there is only ever one holder, so the discriminator
  // is a token per claim instead of an occupancy counter.
  test("a release from an expired write claim does not free the one that replaced it", async () => {
    const o = owner();
    const slow = await claimIngestWrite(o, appDb);
    expect(slow.state).toBe("created");
    await suDb.$executeRawUnsafe(
      `UPDATE agent_threads SET ingest_write_until = now() - interval '1 second'
        WHERE tenant_id = ${tenantId} AND contact_inbox_id = ${o.contactInboxId}`,
    );
    const next = await claimIngestWrite(o, appDb);
    expect(next.state).toBe("claimed");
    expect(next.token).not.toBe(slow.token);
    // The slow append finishes. Its release must not clear the newer claim, and must not delete the
    // row out from under it either.
    await releaseIngestWrite(o, appDb, slow);
    expect((await rowOf(o)).ingestWriteUntil).not.toBeNull();
    expect((await claimIngestWrite(o, appDb)).state).toBe("busy");
    await releaseIngestWrite(o, appDb, next);
    expect((await claimIngestWrite(o, appDb)).state).toBe("claimed");
  });

  // A LEASE THAT RENEWS WHILE THE INVOKE RUNS. 300 seconds is generous for one model call and far
  // too short as a ceiling on a tool-heavy turn; without renewal the claim lapses under a turn that
  // never stopped, an append reads the thread as free, and the invoke erases it. Measured against a
  // deliberately short window rather than by waiting 300 seconds.
  test("the hold outlives its own lease while the turn is alive", async () => {
    const o = owner();
    const hold = await markTurnOwning(o, appDb);
    const before = (await rowOf(o)).turnHeldUntil as Date;
    // The renewal interval is minutes long, so the renewing statement is exercised directly here;
    // what this pins is that renewal targets THIS occupancy and moves the lease forward.
    await suDb.$executeRawUnsafe(
      `UPDATE agent_threads
          SET turn_held_until = now() + interval '600 seconds'
        WHERE tenant_id = ${tenantId} AND contact_inbox_id = ${o.contactInboxId}
          AND turn_epoch = ${hold.epoch} AND turn_holders > 0`,
    );
    const after = (await rowOf(o)).turnHeldUntil as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(await turnOwnsThread(o, appDb)).toBe(true);
    await clearTurnOwning(o, appDb, hold);
  });

  // Whether another invoke was already reading has to come from the ACQUIRING statement. Asked
  // separately, two replicas starting together both read "nobody" and both act as if alone.
  test("the claim reports whether it joined an occupancy or started one", async () => {
    const o = owner();
    const first = await markTurnOwning(o, appDb);
    expect(first.heldBefore).toBe(false);
    const second = await markTurnOwning(o, appDb);
    expect(second.heldBefore).toBe(true);
    await clearTurnOwning(o, appDb, second);
    await clearTurnOwning(o, appDb, first);
  });

  // The write lease renews too. It is the same property the turn lease has, and the append is the
  // side whose failure is irreversible, so leaving it out was leaving the hole open on the half that
  // matters most: a stalled checkpointer write past 30 seconds would let a turn start beside an
  // append that is still going to write.
  test("the write claim outlives its own lease while the append is alive", async () => {
    const o = owner();
    const claim = await claimIngestWrite(o, appDb);
    expect(claim.state).toBe("created");
    const before = (await rowOf(o)).ingestWriteUntil as Date;
    await suDb.$executeRawUnsafe(
      `UPDATE agent_threads
          SET ingest_write_until = now() + interval '600 seconds'
        WHERE tenant_id = ${tenantId} AND contact_inbox_id = ${o.contactInboxId}
          AND ingest_write_token = '${claim.token}'`,
    );
    const after = (await rowOf(o)).ingestWriteUntil as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    // Still exclusive against a turn, which is the whole point of holding it longer.
    expect((await rowOf(o)).turnHolders).toBe(0);
    // Released with nothing written to the row, so the row goes with it (the rule the two tests
    // below pin); what this one is about is that the lease moved while the append was alive.
    await releaseIngestWrite(o, appDb, claim);
    expect(
      await suDb.agentThread.count({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: o.contactInboxId,
        },
      }),
    ).toBe(0);
  });

  // WHAT /reset HAS TO EXCLUDE IS BOTH SIDES, not just a turn. On the sanctioned topology the append
  // runs on the leader and the reset arrives on a web replica, so a question about turns alone said
  // nothing about an append in flight, and the reset went on to delete the checkpoint that append
  // was about to write a watermark for.
  test("a live append makes the thread busy for a reset, not only a turn", async () => {
    const o = owner();
    const claim = await claimIngestWrite(o, appDb);
    expect(claim.state).toBe("created");
    expect(
      await runScopedOn(appDb, sysCtx(tenantId), (db) =>
        threadBusyForResetOn(db, o),
      ),
    ).toBe(true);
    await releaseIngestWrite(o, appDb, claim);
    expect(
      await runScopedOn(appDb, sysCtx(tenantId), (db) =>
        threadBusyForResetOn(db, o),
      ),
    ).toBe(false);
  });

  test("a turn also makes the thread busy for a reset", async () => {
    const o = owner();
    const hold = await markTurnOwning(o, appDb);
    expect(
      await runScopedOn(appDb, sysCtx(tenantId), (db) =>
        threadBusyForResetOn(db, o),
      ),
    ).toBe(true);
    await clearTurnOwning(o, appDb, hold);
    expect(
      await runScopedOn(appDb, sysCtx(tenantId), (db) =>
        threadBusyForResetOn(db, o),
      ),
    ).toBe(false);
  });

  // A SLOW APPEND IS NOT A STUCK ONE. Once the write lease renews, a fixed deadline measured from
  // the start of the wait would fail a customer's turn for an append that is working correctly and
  // saying so. What ends the wait is a lease that STOPPED moving.
  test("the wait follows the append's lease instead of a fixed span", async () => {
    const o = owner();
    const claim = await claimIngestWrite(o, appDb);
    expect(claim.state).toBe("created");
    // The append is alive and keeps pushing its lease forward, the way its renewal does.
    let renewals = 0;
    const renewing = setInterval(() => {
      renewals += 1;
      void suDb.$executeRawUnsafe(
        `UPDATE agent_threads
            SET ingest_write_until = now() + interval '30 seconds'
          WHERE tenant_id = ${tenantId} AND contact_inbox_id = ${o.contactInboxId}
            AND ingest_write_token = '${claim.token}'`,
      );
    }, 50);
    // Give the turn long enough that a fixed deadline shorter than the lease would have fired.
    const took = markTurnOwning(o, appDb).then(() => "took" as const);
    await Bun.sleep(400);
    clearInterval(renewing);
    expect(renewals).toBeGreaterThan(2);
    // Still waiting: the claim never stopped being renewed, so nothing has gone wrong to report.
    const racing = await Promise.race([
      took,
      Bun.sleep(50).then(() => "still waiting" as const),
    ]);
    expect(racing).toBe("still waiting");
    // The append finishes; the turn proceeds.
    await releaseIngestWrite(o, appDb, claim);
    expect(await took).toBe("took");
    await clearTurnOwning(o, appDb, { epoch: null, heldBefore: false });
  }, 20_000);

  test("a turn waits out an append in flight, then takes the thread", async () => {
    const o = owner();
    const hold = await markTurnOwning(o, appDb);
    await clearTurnOwning(o, appDb, hold);
    const write = await claimIngestWrite(o, appDb);
    expect(write.state).toBe("claimed");
    // Released from "another process" while the turn is inside its wait. What is asserted is that
    // the turn did NOT take the thread before the append finished: taking it early is exactly the
    // window that makes the append land inside the invoke.
    const released = (async () => {
      await Bun.sleep(120);
      await releaseIngestWrite(o, appDb, write);
      return Date.now();
    })();
    const took = markTurnOwning(o, appDb).then(() => Date.now());
    const [releasedAt, tookAt] = await Promise.all([released, took]);
    expect(tookAt).toBeGreaterThanOrEqual(releasedAt);
    expect((await rowOf(o)).turnHolders).toBe(1);
  });
});
