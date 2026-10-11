import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { clearTurnInFlight } from "@/graph/inflight";
import {
  clearTurnOwning,
  markTurnOwning,
  type ThreadOwner,
  turnOwnsThread,
  turnWaitDeadline,
} from "@/graph/thread-claim";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// A turn whose process dies stops renewing its claim on the thread, and the claim's lease is the only
// thing that tells every other reader (a delivery recovery, the next turn, an append) that it is gone.
// So the lease bounds how long a dead turn keeps the conversation unanswered, and the renewal is what
// keeps a live turn's claim from lapsing however long it runs. Both are asserted on the row, with the
// lease read in Postgres's clock, which is the one that mints it.

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

describe.skipIf(!dbUp)("a turn claim whose holder is gone", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TCD", slug: `tcd-${process.pid}` },
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

  let nextInbox = 13_070;
  function owner(): ThreadOwner {
    const contactInboxId = nextInbox++;
    return {
      tenantId,
      instanceId,
      contactInboxId,
      graphThreadId: contactInboxThreadId(tenantId, instanceId, contactInboxId),
    };
  }

  // Seconds left on the claim's lease, by the database's clock.
  async function leaseLeft(o: ThreadOwner): Promise<number> {
    const rows = await suDb.$queryRaw<{ left_s: number }[]>`
      SELECT extract(epoch from (turn_held_until - now()))::float8 AS left_s
        FROM agent_threads
       WHERE tenant_id = ${tenantId}
         AND chatwoot_instance_id = ${instanceId}
         AND contact_inbox_id = ${o.contactInboxId}`;
    return rows[0]?.left_s ?? Number.NaN;
  }

  // Catches a lease long enough that a recovery of the dead turn's delivery is deferred for minutes:
  // with five minutes the answer lands about six minutes after the death.
  test("a claim nobody renews lapses within a minute, joined or not", async () => {
    const o = owner();
    const first = await markTurnOwning(o, appDb);
    const created = await leaseLeft(o);
    const joined = await markTurnOwning(o, appDb);
    first.stopRenewal?.();
    joined.stopRenewal?.();
    clearTurnInFlight(o.graphThreadId);
    const left = await leaseLeft(o);
    for (const l of [created, left]) {
      expect(l).toBeGreaterThan(30);
      expect(l).toBeLessThanOrEqual(60);
    }
  });

  // Catches a renewal too sparse for the lease: a live turn whose claim lapses between two renewals
  // reads as dead, and the recovery starts a second turn beside it.
  test("a live turn renews its claim before the lease can lapse", async () => {
    const o = owner();
    jest.useFakeTimers();
    try {
      const hold = await markTurnOwning(o, appDb);
      clearTurnInFlight(o.graphThreadId);
      await suDb.$executeRaw`
        UPDATE agent_threads SET turn_held_until = now() + interval '15 seconds'
         WHERE tenant_id = ${tenantId}
           AND chatwoot_instance_id = ${instanceId}
           AND contact_inbox_id = ${o.contactInboxId}`;
      jest.advanceTimersByTime(10_000);
      let left = await leaseLeft(o);
      for (let i = 0; i < 100 && left < 20; i++) left = await leaseLeft(o);
      expect(left).toBeGreaterThan(20);
      expect(left).toBeLessThanOrEqual(60);
      expect(await turnOwnsThread(o, appDb)).toBe(true);
      await clearTurnOwning(o, appDb, hold);
    } finally {
      jest.useRealTimers();
    }
  });

  // Catches a rolling deploy cutting short the claim of a live turn on the previous release, which
  // took a 300-second lease and renews it every 100: a turn on this release joining the occupancy,
  // or renewing its own hold beside it, must not pull that lease down to 60 seconds, or it lapses
  // before the old turn's next renewal and an append lands inside its invoke.
  test("joining or renewing beside a longer lease keeps it", async () => {
    const o = owner();
    jest.useFakeTimers();
    try {
      const old = await markTurnOwning(o, appDb);
      old.stopRenewal?.();
      clearTurnInFlight(o.graphThreadId);
      await suDb.$executeRaw`
        UPDATE agent_threads SET turn_held_until = now() + interval '300 seconds'
         WHERE tenant_id = ${tenantId}
           AND chatwoot_instance_id = ${instanceId}
           AND contact_inbox_id = ${o.contactInboxId}`;
      const joined = await markTurnOwning(o, appDb);
      clearTurnInFlight(o.graphThreadId);
      const afterJoin = await leaseLeft(o);
      jest.advanceTimersByTime(10_000);
      // the renewal is fire-and-forget; give its statement time to land before reading
      for (let i = 0; i < 20; i++) await leaseLeft(o);
      const afterRenew = await leaseLeft(o);
      expect(afterJoin).toBeGreaterThan(290);
      expect(afterRenew).toBeGreaterThan(290);
      await clearTurnOwning(o, appDb, joined);
      await clearTurnOwning(o, appDb, old);
    } finally {
      jest.useRealTimers();
    }
  });

  // Catches the wait for a turn already on the thread shrinking with the lease: a live turn longer
  // than one lease would then have a second turn started beside it, which erases a message.
  test("a second turn waits out a live one for five minutes, not one lease", () => {
    expect(turnWaitDeadline() - Date.now()).toBeGreaterThanOrEqual(300_000);
  });
});
