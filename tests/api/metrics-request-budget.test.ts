import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildApp } from "@/app";
import config from "@/config";
import { runMetricsScoped } from "@/modules/analytics/budget";

// A metrics request has one budget, counted from when the request arrived: whatever it spent before
// the read (authentication waiting on the metrics pool, an earlier read of the same request) is gone
// from the read's share. Driven through the app the server runs, so the request's start is the one its
// own middleware records.

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let db: PrismaClient | undefined;
if (appUrl) {
  try {
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 2 }),
    });
    await db.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
afterAll(async () => {
  await db?.$disconnect();
});

const ctx = { tenantId: 1n, role: "TENANT_ADMIN" as const, userId: 1n };

describe.skipIf(!dbUp)("a metrics request's budget", () => {
  test("a read that starts late in the request gets only what is left of the request's budget", async () => {
    const app = await buildApp();
    // The request spends 0.6 s before its read, as a session lookup queued on a full metrics pool
    // would, and the read then needs 0.6 s: 1.2 s in all against a 1 s budget.
    app.get("/__metrics/late-read", async () => {
      await db?.$queryRawUnsafe("SELECT pg_sleep(0.6)::text");
      return runMetricsScoped(db as PrismaClient, ctx, async (scoped) => {
        await scoped.$queryRawUnsafe("SELECT pg_sleep(0.6)::text");
        return { answered: true };
      });
    });
    const saved = config.metrics.timeoutMs;
    config.metrics.timeoutMs = 1_000;
    try {
      const t0 = Date.now();
      const res = await app.handle(
        new Request("http://localhost/__metrics/late-read"),
      );
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(503);
      const body = (await res.json()) as { field?: string; error?: string };
      expect(body.field).toBe("since");
      expect(elapsed).toBeLessThan(1_300);
    } finally {
      config.metrics.timeoutMs = saved;
    }
  });

  test("a read that starts late waits for a connection only as long as the request has left", async () => {
    const app = await buildApp();
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    try {
      await one.$queryRaw`SELECT 1`;
      let holder: Promise<unknown> = Promise.resolve();
      // 0.6 s pass before the read, and the pool's one connection is held to 1.6 s.
      app.get("/__metrics/late-wait", async () => {
        holder = one.$transaction(
          async (tx) => {
            await tx.$queryRawUnsafe("SELECT pg_sleep(1.6)::text");
          },
          { timeout: 5_000 },
        );
        await db?.$queryRawUnsafe("SELECT pg_sleep(0.6)::text");
        return runMetricsScoped(one, ctx, async () => ({ answered: true }));
      });
      const saved = config.metrics.timeoutMs;
      config.metrics.timeoutMs = 1_000;
      try {
        const t0 = Date.now();
        const res = await app.handle(
          new Request("http://localhost/__metrics/late-wait"),
        );
        const elapsed = Date.now() - t0;
        expect(res.status).toBe(503);
        expect(elapsed).toBeLessThan(1_300);
      } finally {
        config.metrics.timeoutMs = saved;
        await holder;
      }
    } finally {
      await one.$disconnect();
    }
  });
});
