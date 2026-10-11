import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { lockTimeoutOption } from "@/api/lib/pool-options";
import config from "@/config";
import { runScopedOn } from "@/lib/tenancy";

// A transaction's `timeout` has to bound how long it holds its connection, not only whether it
// commits. Prisma checks it when a statement returns, so without Postgres enforcing it a statement
// that runs or waits on a lock past the budget keeps the connection to the end: the pool fills with
// transactions that can no longer commit.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 4 }),
    });
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
afterAll(async () => {
  await app?.$disconnect();
  await su?.$disconnect();
});

const ctx = { tenantId: 1n, role: "TENANT_ADMIN" as const, userId: 1n };
const budget = { maxWait: 1_000, timeout: 500 };

async function stillRunning(marker: string): Promise<number> {
  const [row] = await (su as PrismaClient).$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE state = 'active' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`,
  );
  return row?.n ?? -1;
}

describe.skipIf(!dbUp)("transaction budget", () => {
  test("a statement past the transaction's timeout is cancelled at the timeout and frees its connection", async () => {
    const t0 = Date.now();
    const err = await runScopedOn(
      app as PrismaClient,
      ctx,
      (db) => db.$queryRawUnsafe("SELECT pg_sleep(4)::text /* txb_sleep */"),
      budget,
    ).catch((e) => e);
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(2_000);
    expect(await stillRunning("txb_sleep")).toBe(0);
  });

  test("a lock wait past the timeout inside a transaction gives the connection back", async () => {
    let waitedMs = -1;
    let left = -1;
    await (su as PrismaClient).$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(919191)::text`;
        const t0 = Date.now();
        await runScopedOn(
          app as PrismaClient,
          ctx,
          (db) =>
            db.$queryRawUnsafe(
              "SELECT pg_advisory_xact_lock(919191)::text /* txb_lock */",
            ),
          budget,
        ).catch(() => {});
        waitedMs = Date.now() - t0;
        left = await stillRunning("txb_lock");
      },
      { timeout: 10_000 },
    );
    expect(waitedMs).toBeLessThan(2_000);
    expect(left).toBe(0);
  });

  test("a transaction whose statements each fit but together outlive the budget does not commit", async () => {
    const err = await runScopedOn(
      app as PrismaClient,
      ctx,
      async (db) => {
        await db.$queryRawUnsafe("SELECT pg_sleep(0.3)::text");
        await db.$queryRawUnsafe("SELECT pg_sleep(0.3)::text");
        return "committed";
      },
      budget,
    ).catch((e) => e);
    expect(err).not.toBe("committed");
  });

  test("a transaction inside its budget commits as before", async () => {
    const out = await runScopedOn(
      app as PrismaClient,
      ctx,
      async (db) => {
        await db.$queryRawUnsafe("SELECT pg_sleep(0.2)::text");
        return db.$queryRaw<
          { v: string }[]
        >`SELECT current_setting('statement_timeout') AS v`;
      },
      { maxWait: 1_000, timeout: 2_000 },
    );
    expect(out[0]?.v).toBe("2s");
  });

  test("a pool built with DB_LOCK_TIMEOUT_MS cancels a lock wait outside any transaction, and 0 sets none", async () => {
    const saved = config.dbLockTimeoutMs;
    config.dbLockTimeoutMs = 300;
    const bounded = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: appUrl,
        ...lockTimeoutOption(),
      }),
    });
    config.dbLockTimeoutMs = 0;
    const unbounded = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: appUrl,
        ...lockTimeoutOption(),
      }),
    });
    config.dbLockTimeoutMs = saved;
    try {
      let code: unknown;
      let waitedMs = -1;
      await (su as PrismaClient).$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(929292)::text`;
          const t0 = Date.now();
          code = await bounded
            .$queryRawUnsafe("SELECT pg_advisory_xact_lock(929292)::text")
            .then(
              () => "acquired",
              (e) => e.meta?.driverAdapterError?.cause?.originalCode,
            );
          waitedMs = Date.now() - t0;
        },
        { timeout: 10_000 },
      );
      expect(code).toBe("55P03");
      expect(waitedMs).toBeLessThan(2_000);
      const [row] = await unbounded.$queryRaw<{ v: string }[]>`
        SELECT current_setting('lock_timeout') AS v`;
      expect(row?.v).toBe("0");
    } finally {
      await bounded.$disconnect();
      await unbounded.$disconnect();
    }
  });
});
