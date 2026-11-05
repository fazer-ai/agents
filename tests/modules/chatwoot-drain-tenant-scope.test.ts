import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  drainStoredChatwootDeliveries,
  resetChatwootAdmissionForTest,
} from "@/modules/chatwoot/delivery-queue";
import { sweepStrandedDeliveries } from "@/modules/chatwoot/delivery-sweep";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// The per-tenant drain and the stranded-delivery sweep read as the fleet, because scoped their enum
// `status` predicate cannot reach an index. Outside the tenant policy the isolation is the explicit
// filter, so a pass for one tenant must not hand on, admit, clear or settle another tenant's rows.
// Catches a read that dropped the filter.
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const MINUTE = 60_000;
const tenants: bigint[] = [];
const instances: bigint[] = [];

async function seedTenant(n: number): Promise<void> {
  const t = await suDb.tenant.create({
    data: { name: `Drain ${n}`, slug: `drain1700-${n}-${process.pid}` },
  });
  tenants.push(t.id);
  const inst = await suDb.chatwootInstance.count();
  const i = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId: 17_000 + n + inst,
  });
  instances.push(i.id);
}

// A customer message whose body is gone and that nothing processed: the shape the drain hands on.
function strand(k: number, deliveryId: string) {
  return suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId: tenants[k] as bigint,
      chatwootInstanceId: instances[k] as bigint,
      deliveryId,
      event: "message_created",
      status: "PENDING",
      payload: null,
      conversationId: 1_700 + k,
      inboundMessageId: 9_000 + k,
      receivedAt: new Date(Date.now() - 10 * MINUTE),
    },
    select: { id: true },
  });
}

// A body past the drain's age ceiling: the pass of its own tenant clears it.
function oldBody(k: number, deliveryId: string) {
  return suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId: tenants[k] as bigint,
      chatwootInstanceId: instances[k] as bigint,
      deliveryId,
      event: "conversation_updated",
      status: "PENDING",
      payload: "opaque",
      receivedAt: new Date(Date.now() - 7 * 60 * MINUTE),
    },
    select: { id: true },
  });
}

describe.skipIf(!dbUp)(
  "a tenant's drain pass reaches only that tenant's deliveries",
  () => {
    beforeAll(async () => {
      await seedTenant(1);
      await seedTenant(2);
      // Holds nothing of its own: whatever its sweep settles came from another tenant.
      await seedTenant(3);
    });

    afterAll(async () => {
      resetChatwootAdmissionForTest();
      for (const id of tenants) {
        await suDb.schedulerJob.deleteMany({ where: { tenantId: id } });
        await suDb.chatwootWebhookDelivery.deleteMany({
          where: { tenantId: id },
        });
        await suDb.tenant.delete({ where: { id } });
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("the other tenant's strand stays PENDING and its old body is not cleared", async () => {
      const mine = await strand(0, `s-mine-${process.pid}`);
      const theirs = await strand(1, `s-theirs-${process.pid}`);
      const theirOld = await oldBody(1, `b-theirs-${process.pid}`);
      const myOld = await oldBody(0, `b-mine-${process.pid}`);

      const r = await drainStoredChatwootDeliveries({
        base: appDb,
        tenantId: tenants[0],
        minAgeMs: MINUTE,
      });

      expect(r.recovered).toBe(1);
      expect(r.cleared).toBe(1);
      const row = (id: bigint) =>
        suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id },
          select: { status: true, payload: true },
        });
      expect((await row(mine.id)).status).not.toBe("PENDING");
      expect(await row(theirs.id)).toEqual({
        status: "PENDING",
        payload: null,
      });
      expect((await row(myOld.id)).payload).toBeNull();
      expect((await row(theirOld.id)).payload).toBe("opaque");
      const theirJobs = await suDb.schedulerJob.count({
        where: { tenantId: tenants[1] },
      });
      expect(theirJobs).toBe(0);
    });

    test("the stranded sweep of a tenant with no rows settles nothing of another tenant's", async () => {
      const stale = new Date(Date.now() - 60 * MINUTE);
      const theirs = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId: tenants[1] as bigint,
          chatwootInstanceId: instances[1] as bigint,
          deliveryId: `p-theirs-${process.pid}`,
          event: "message_created",
          status: "PROCESSING",
          payload: null,
          attempts: 1,
          receivedAt: stale,
          claimedAt: stale,
        },
        select: { id: true },
      });
      const counts = await sweepStrandedDeliveries({
        tenantId: tenants[2] as bigint,
        base: appDb,
      });
      expect(Object.values(counts).every((n) => n === 0)).toBe(true);
      const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
        where: { id: theirs.id },
        select: { status: true, attempts: true },
      });
      expect(row).toEqual({ status: "PROCESSING", attempts: 1 });
    });
  },
);
