import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  getWebhookDelivery,
  type ListDeliveriesOpts,
  listWebhookDeliveries,
  requeueWebhookDelivery,
} from "@/modules/webhooks/outbound/deliveries";
import { processOutboundBatch } from "@/modules/webhooks/outbound/worker";

// ── THE DELIVERY LEDGER AS A SUPPORTED SURFACE (issue #305) ──
// Integration, real DB, real RLS: every call goes through `runScopedOn` exactly as the controller
// and the MCP tools reach it, so a cross-tenant read fails here the way it would in production
// rather than the way a mocked client would let it.
//
// The effect asserted for the requeue is never the returned DTO alone: a requeue that does not put
// the row where the WORKER will pick it up is a status change and nothing more. So the worker runs
// for real (claim, backoff, outcome) and the assertion is that the receiver was posted to.

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

// A secret-looking string inside the stored payload, so "the payload does not cross this surface"
// is something the test can catch rather than something the reviewer has to trust.
const PAYLOAD_MARKER = "sk-live-PAYLOAD-MUST-NOT-LEAK-305";

let tenantId = 0n;
let otherTenantId = 0n;
let liveSub = 0n;
let disabledSub = 0n;
let otherSub = 0n;

function ctxOf(id: bigint): TenantContext {
  return { tenantId: id, userId: null, role: "TENANT_ADMIN" };
}
const ctx = () => ctxOf(tenantId);

async function seed(
  opts: {
    sub?: bigint;
    tenant?: bigint;
    status?: "PENDING" | "SENDING" | "DELIVERED" | "DEAD";
    attempts?: number;
    event?: string;
    lastError?: string | null;
  } = {},
): Promise<bigint> {
  const row = await suDb.outboundWebhookDelivery.create({
    data: {
      tenantId: opts.tenant ?? tenantId,
      subscriptionId: opts.sub ?? liveSub,
      event: opts.event ?? "conversion",
      payload: { value: 42, token: PAYLOAD_MARKER },
      status: opts.status ?? "DEAD",
      attempts: opts.attempts ?? 8,
      lastError:
        opts.lastError === undefined ? "non-2xx response: 500" : opts.lastError,
    },
  });
  return row.id;
}

async function clearDeliveries() {
  await suDb.$executeRawUnsafe(
    `DELETE FROM outbound_webhook_deliveries WHERE tenant_id IN (${tenantId}, ${otherTenantId})`,
  );
}

// The emit is fire-and-forget, so the line lands after the call returned. Poll for it rather than
// sleeping a fixed amount: a fixed sleep is either flaky or slow and never says which.
async function webhookLines(expected: number, waitMs = 3000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // flowlog-scope: tenant-wide — the subject is HOW MANY lines a requeue writes, so scoping the
    // read to a turn would answer a different question and stay green with a second row present.
    // The tenant is this file's own and the rows are cleared before each case that reads them.
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, stage: "webhook" },
      orderBy: { id: "asc" },
    });
    if (rows.length >= expected) return rows;
    if (Date.now() > deadline) return rows;
    await Bun.sleep(50);
  }
}

describe.skipIf(!dbUp)("outbound webhook delivery ledger", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "WDL", slug: `wdl-${process.pid}` },
    });
    tenantId = t.id;
    const o = await suDb.tenant.create({
      data: { name: "WDLO", slug: `wdlo-${process.pid}` },
    });
    otherTenantId = o.id;
    liveSub = (
      await suDb.webhookSubscription.create({
        data: {
          tenantId,
          url: "https://example.com/live",
          events: ["conversion"],
          enabled: true,
        },
      })
    ).id;
    disabledSub = (
      await suDb.webhookSubscription.create({
        data: {
          tenantId,
          url: "https://example.com/off",
          events: ["conversion"],
          enabled: false,
        },
      })
    ).id;
    otherSub = (
      await suDb.webhookSubscription.create({
        data: {
          tenantId: otherTenantId,
          url: "https://example.com/other",
          events: ["conversion"],
          enabled: true,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId)
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    if (otherTenantId)
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${otherTenantId}`,
      );
    await su?.$disconnect();
    await app?.$disconnect();
  });

  describe("list", () => {
    test("returns the tenant's deliveries newest first, and never the payload", async () => {
      await clearDeliveries();
      const first = await seed({ event: "conversion" });
      const second = await seed({ event: "heartbeat", status: "DELIVERED" });
      const res = await listWebhookDeliveries(ctx(), {}, appDb);
      expect(res.items.map((d) => d.id)).toEqual([
        String(second),
        String(first),
      ]);
      // The whole serialized page, not a key check on one item: a payload leaking through a nested
      // relation would pass `"payload" in item` and still ship the customer's data.
      const wire = JSON.stringify(res);
      expect(wire).not.toContain(PAYLOAD_MARKER);
      expect(wire).not.toContain("payload");
      expect(res.items[0]).toMatchObject({
        subscriptionId: String(liveSub),
        subscriptionEnabled: true,
        event: "heartbeat",
        status: "DELIVERED",
        attempts: 8,
        lastError: "non-2xx response: 500",
      });
    });

    test("filters by status, subscription and event", async () => {
      await clearDeliveries();
      const dead = await seed({ status: "DEAD" });
      await seed({ status: "PENDING" });
      const onDisabled = await seed({ sub: disabledSub, event: "heartbeat" });

      expect(
        (await listWebhookDeliveries(ctx(), { status: "DEAD" }, appDb)).items
          .map((d) => d.id)
          .sort(),
      ).toEqual([String(dead), String(onDisabled)].sort());
      expect(
        (
          await listWebhookDeliveries(
            ctx(),
            { subscriptionId: disabledSub },
            appDb,
          )
        ).items.map((d) => d.id),
      ).toEqual([String(onDisabled)]);
      expect(
        (
          await listWebhookDeliveries(ctx(), { event: "heartbeat" }, appDb)
        ).items.map((d) => d.id),
      ).toEqual([String(onDisabled)]);
    });

    test("a filter value the server cannot parse is refused, not dropped", async () => {
      // Dropping it is the wrong answer twice: a bad `subscriptionId` would widen the page to the
      // whole tenant, and a bad `limit` reaches Prisma, where NaN throws and 3.5 quietly returns
      // nothing. The service owns the range so MCP, which never goes through the query parser, is
      // held to the same rule.
      const bad: Array<[string, ListDeliveriesOpts]> = [
        ["since", { since: new Date("garbage") }],
        ["until", { until: new Date("garbage") }],
        ["limit", { limit: Number.NaN }],
        ["limit", { limit: 3.5 }],
        ["limit", { limit: 0 }],
      ];
      for (const [param, opts] of bad) {
        const err = await listWebhookDeliveries(ctx(), opts, appDb).catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect((err as AppError).field).toBe(param);
      }
    });

    test("an unknown status is refused, not answered with an empty page", async () => {
      // FAILED is the trap: it is a real value of the shared Prisma enum that only the INBOUND side
      // writes, so accepting it would answer "no deliveries" to a filter that can never match.
      for (const bad of ["FAILED", "dead", "nope"]) {
        const err = await listWebhookDeliveries(
          ctx(),
          { status: bad },
          appDb,
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
      }
    });

    test("keyset pagination walks the whole ledger without repeating a row", async () => {
      await clearDeliveries();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(String(await seed({})));
      const page1 = await listWebhookDeliveries(ctx(), { limit: 2 }, appDb);
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBe(page1.items[1]?.id ?? null);
      const page2 = await listWebhookDeliveries(
        ctx(),
        { limit: 2, cursor: BigInt(page1.nextCursor as string) },
        appDb,
      );
      const page3 = await listWebhookDeliveries(
        ctx(),
        { limit: 2, cursor: BigInt(page2.nextCursor as string) },
        appDb,
      );
      const walked = [...page1.items, ...page2.items, ...page3.items].map(
        (d) => d.id,
      );
      expect(walked).toEqual([...ids].reverse());
      expect(page3.nextCursor).toBeNull();
    });

    test("subscriptionEnabled tells a queued delivery from a parked one", async () => {
      await clearDeliveries();
      await seed({ sub: disabledSub, status: "PENDING" });
      const [item] = (await listWebhookDeliveries(ctx(), {}, appDb)).items;
      expect(item?.status).toBe("PENDING");
      expect(item?.subscriptionEnabled).toBe(false);
    });
  });

  describe("get", () => {
    test("returns one delivery by id", async () => {
      await clearDeliveries();
      const id = await seed({});
      const d = await getWebhookDelivery(ctx(), id, appDb);
      expect(d.id).toBe(String(id));
      expect(JSON.stringify(d)).not.toContain(PAYLOAD_MARKER);
    });

    test("a missing id is a 404", async () => {
      const err = await getWebhookDelivery(ctx(), 999_999_999n, appDb).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(404);
    });
  });

  describe("requeue", () => {
    test("a dead delivery goes back to PENDING with its attempt count reset", async () => {
      await clearDeliveries();
      const id = await seed({ status: "DEAD", attempts: 8 });
      const { delivery: d, before } = await requeueWebhookDelivery(
        ctx(),
        id,
        appDb,
      );
      // What the requeue undid, read under the lock — the audit trail's `before` comes from here.
      expect(before).toEqual({ status: "DEAD", attempts: 8 });
      expect(d).toMatchObject({
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: null,
        // Kept, not cleared: a row retrying today already carries its last error while PENDING.
        lastError: "non-2xx response: 500",
      });
      const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(0);
    });

    test("the requeued delivery is actually claimed and posted by the worker", async () => {
      await clearDeliveries();
      const id = await seed({ status: "DEAD", attempts: 8 });
      await requeueWebhookDelivery(ctx(), id, appDb);
      const posted: string[] = [];
      const summary = await processOutboundBatch({
        base: suDb,
        tenantId,
        assertSafe: async (u: string) => new URL(u),
        fetchImpl: (async (url: string) => {
          posted.push(String(url));
          return { status: 200 } as Response;
        }) as unknown as typeof fetch,
      });
      // The effect, not the return value: the receiver was posted to and the row is DELIVERED.
      expect(posted).toEqual(["https://example.com/live"]);
      expect(summary.delivered).toBe(1);
      const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe("DELIVERED");
      expect(row.attempts).toBe(1);
    });

    test("a requeue keeping the attempt count would buy ONE post, which is why it resets", async () => {
      // The measurement behind the design, run as a test so it cannot quietly stop being true:
      // `finalizeFailure` gives up at attempts + 1 >= MAX_ATTEMPTS, so a row put back at 8 dies on
      // the first failure while the same row put back at 0 earns a fresh ladder.
      await clearDeliveries();
      const withCount = await seed({ status: "DEAD", attempts: 8 });
      await suDb.outboundWebhookDelivery.update({
        where: { id: withCount },
        data: { status: "PENDING", nextAttemptAt: null },
      });
      const reset = await seed({ status: "DEAD", attempts: 8 });
      await requeueWebhookDelivery(ctx(), reset, appDb);
      await processOutboundBatch({
        base: suDb,
        tenantId,
        assertSafe: async (u: string) => new URL(u),
        fetchImpl: (async () =>
          ({ status: 500 }) as Response) as unknown as typeof fetch,
      });
      const kept = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id: withCount },
      });
      const fresh = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id: reset },
      });
      expect([kept.status, kept.attempts]).toEqual(["DEAD", 9]);
      expect([fresh.status, fresh.attempts]).toEqual(["PENDING", 1]);
      expect(fresh.nextAttemptAt).not.toBeNull();
    });

    test("a requeue that arrives as the worker is dying reads the count it died at", async () => {
      // The narrow window the lock exists for. The worker is mid-outcome: the row still reads
      // SENDING/7 to anyone who looks without a lock, and the transaction that will commit DEAD/8
      // is already holding it. A requeue that reads before that commit would either refuse a row
      // that is about to be dead, or requeue it while writing 7 into the line meant to preserve
      // the count the delivery died at. `FOR UPDATE` makes it wait and then read the truth.
      await clearDeliveries();
      await suDb.$executeRawUnsafe(
        `DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`,
      );
      const id = await seed({ status: "SENDING", attempts: 7 });
      const holder = suDb.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE outbound_webhook_deliveries SET status = 'DEAD', attempts = 8 WHERE id = ${id}`,
          );
          await Bun.sleep(500);
        },
        { timeout: 10_000 },
      );
      await Bun.sleep(120);
      const [, requeued] = await Promise.all([
        holder,
        requeueWebhookDelivery(ctx(), id, appDb),
      ]);
      expect(requeued.delivery.status).toBe("PENDING");
      expect(requeued.delivery.attempts).toBe(0);
      expect(requeued.before).toEqual({ status: "DEAD", attempts: 8 });
      const [line] = await webhookLines(1);
      expect(line?.detail).toMatchObject({
        action: "requeued",
        attemptsBefore: 8,
      });
    });

    test("a delivery the worker is holding (SENDING) is refused, untouched", async () => {
      // The one that matters for safety: SENDING means a POST is in flight, and putting the row
      // back to PENDING would let a second claim deliver it again.
      await clearDeliveries();
      const id = await seed({ status: "SENDING", attempts: 3 });
      const err = await requeueWebhookDelivery(ctx(), id, appDb).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).message).toContain("SENDING");
      const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id },
      });
      expect([row.status, row.attempts]).toEqual(["SENDING", 3]);
    });

    test("a requeue that loses the race names the status the row has NOW", async () => {
      // Two operators clearing the same dead-letter page. Both transactions read DEAD, the losers
      // block on the winner and then match nothing — and the status to report is the one after
      // that wait, not the one from before it. Reporting the stale read answers "this one is DEAD"
      // about a row that is already PENDING, which is the single refusal a caller would be right
      // to retry.
      await clearDeliveries();
      const id = await seed({ status: "DEAD", attempts: 8 });
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          requeueWebhookDelivery(ctx(), id, appDb).catch((e: unknown) => e),
        ),
      );
      const won = outcomes.filter((o) => !(o instanceof Error));
      const lost = outcomes.filter((o) => o instanceof AppError) as AppError[];
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(7);
      for (const e of lost) {
        expect(e.statusCode).toBe(409);
        expect(e.message).toContain("PENDING");
        expect(e.message).not.toContain("DEAD");
      }
      const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id },
      });
      expect([row.status, row.attempts]).toEqual(["PENDING", 0]);
    });

    test("PENDING and DELIVERED are refused too, each naming itself", async () => {
      await clearDeliveries();
      for (const status of ["PENDING", "DELIVERED"] as const) {
        const id = await seed({ status, attempts: 1 });
        const err = await requeueWebhookDelivery(ctx(), id, appDb).catch(
          (e: unknown) => e,
        );
        expect((err as AppError).statusCode).toBe(409);
        expect((err as AppError).message).toContain(status);
      }
    });

    test("the requeue writes one info line that keeps the count the row died at", async () => {
      await clearDeliveries();
      await suDb.$executeRawUnsafe(
        `DELETE FROM execution_logs WHERE tenant_id = ${tenantId}`,
      );
      const id = await seed({ status: "DEAD", attempts: 8 });
      await requeueWebhookDelivery(ctx(), id, appDb);
      const [line, ...rest] = await webhookLines(1);
      expect(rest).toHaveLength(0);
      expect(line?.level).toBe("info");
      expect(line?.status).toBe("ok");
      expect(line?.source).toBe("inbox");
      expect(line?.detail).toMatchObject({
        deliveryId: String(id),
        subscriptionId: String(liveSub),
        event: "conversion",
        action: "requeued",
        // The row is at 0 by now, so this line is the only place the number survives.
        attemptsBefore: 8,
        subscriptionEnabled: true,
      });
      // The row carries bigint columns, which JSON.stringify refuses outright.
      const asText = JSON.stringify(line, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      expect(asText).not.toContain(PAYLOAD_MARKER);
      // info never pages: `dispatchAlertsForEvent` only routes warn and error.
      const alerts = await suDb.alertDelivery.findMany({ where: { tenantId } });
      expect(alerts).toHaveLength(0);
    });

    test("a requeue into a disabled subscription succeeds and says the queue is holding it", async () => {
      await clearDeliveries();
      const id = await seed({ sub: disabledSub, status: "DEAD", attempts: 8 });
      const { delivery: d } = await requeueWebhookDelivery(ctx(), id, appDb);
      expect(d.status).toBe("PENDING");
      expect(d.subscriptionEnabled).toBe(false);
      const summary = await processOutboundBatch({
        base: suDb,
        tenantId,
        assertSafe: async (u: string) => new URL(u),
        fetchImpl: (async () => {
          throw new Error("a disabled subscription must not be posted to");
        }) as unknown as typeof fetch,
      });
      expect(summary.claimed).toBe(0);
      const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe("PENDING");
    });
  });

  describe("tenant isolation", () => {
    test("another tenant's delivery is invisible to list, get and requeue", async () => {
      await clearDeliveries();
      const mine = await seed({});
      const theirs = await seed({ tenant: otherTenantId, sub: otherSub });
      expect(
        (await listWebhookDeliveries(ctx(), {}, appDb)).items.map((d) => d.id),
      ).toEqual([String(mine)]);
      for (const call of [
        () => getWebhookDelivery(ctx(), theirs, appDb),
        () => requeueWebhookDelivery(ctx(), theirs, appDb),
      ]) {
        const err = await call().catch((e: unknown) => e);
        expect((err as AppError).statusCode).toBe(404);
      }
      // And the row is still theirs, untouched.
      const row = await suDb.outboundWebhookDelivery.findUniqueOrThrow({
        where: { id: theirs },
      });
      expect(row.status).toBe("DEAD");
    });
  });
});
