import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import {
  lastLedgerMarkId,
  settleReport,
  settleRepricedQuarters,
} from "@/../scripts/reprice-usage";
import { SuperuserRuntimeError } from "@/lib/db-guard";
import type { TenantContext } from "@/lib/tenancy";
import { getDashboardCosts } from "@/modules/analytics/costs";
import type { DashboardFilter } from "@/modules/analytics/filter";
import { stepLedgerSums } from "@/modules/analytics/ledger-sums";
import { runReprice } from "@/modules/pricing/reprice";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";
import { TEST_TIMEOUT_MS } from "@/tests/utils/timeouts";

// The reprice script settles the dashboard sums of the quarters it repriced before it returns
// (docs/dashboard.md, "Late changes"): right after it, a window over those quarters reads the sums,
// not the rows, and reads the rows' figures.

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
const db = app as PrismaClient;

const MODEL = "deepseek-chat";
const WRONG = "0.9000000000";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const FIRST = NOW - 4 * DAY;
const LAST = NOW - 2 * HOUR;
const noFetch = (async () => Response.json({})) as unknown as typeof fetch;
const ctx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const NINETY_DAYS = (): DashboardFilter => ({
  since: new Date(NOW - 90 * DAY),
  tz: "America/Sao_Paulo",
});

const tenants: bigint[] = [];

async function seedTenant(slug: string, rows: number): Promise<bigint> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  tenants.push(t.id);
  const data: Prisma.LlmUsageCreateManyInput[] = [];
  for (let i = 0; i < rows; i++)
    data.push({
      tenantId: t.id,
      source: "playground",
      model: MODEL,
      promptTokens: 1_000 + i,
      cachedReadTokens: 100,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      completionTokens: 200,
      costUsd: WRONG,
      priceTable: "litellm@0000000old",
      createdAt: new Date(FIRST + Math.floor(((LAST - FIRST) * i) / rows)),
    });
  await suDb.llmUsage.createMany({ data });
  return t.id;
}

async function sumUp(tenantId: bigint): Promise<void> {
  await until(
    "the sums to catch up",
    async () => {
      const s = await stepLedgerSums(db, tenantId);
      return s.caughtUp && s.summedUntil !== null;
    },
    { everyMs: 50, deadlineMs: 60_000 },
  );
}

async function markedQuarters(tenantId: bigint): Promise<number> {
  const [r] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT quarter)::int AS n FROM ledger_sum_marks WHERE tenant_id = ${tenantId}`);
  return r?.n ?? 0;
}

const costs = async (tenantId: bigint) =>
  JSON.parse(
    JSON.stringify(
      await getDashboardCosts(ctx(tenantId), NINETY_DAYS(), db, noFetch),
    ),
  );

// The same block read from the rows: the tenant's state is moved aside for the read.
async function rawCosts(tenantId: bigint) {
  const [state] = await suDb.$queryRaw<
    { summed_until: Date; candidate_at: Date; candidate_xid: string }[]
  >(Prisma.sql`
    DELETE FROM ledger_sums_state WHERE tenant_id = ${tenantId}
    RETURNING summed_until, candidate_at, candidate_xid::text`);
  try {
    return await costs(tenantId);
  } finally {
    if (state)
      await suDb.$executeRaw(Prisma.sql`
        INSERT INTO ledger_sums_state (tenant_id, summed_until, candidate_at, candidate_xid)
        VALUES (${tenantId}, ${state.summed_until}, ${state.candidate_at}, ${state.candidate_xid}::xid8)`);
  }
}

// A repricing as the script runs it, with a price of its own so the figure moves every row.
const reprice = (tenantId: bigint, cost: number) =>
  runReprice(suDb, {
    tenant: tenantId,
    provider: "deepseek",
    model: MODEL,
    apply: true,
    stamp: `litellm@test${cost}`,
    price: () => cost,
  });

let tA = 0n;
let tB = 0n;

beforeAll(async () => {
  if (!dbUp) return;
  tA = await seedTenant("r1853-a", 600);
  tB = await seedTenant("r1853-b", 60);
  await sumUp(tA);
  await sumUp(tB);
}, 120_000);

afterAll(async () => {
  if (dbUp)
    for (const t of tenants)
      await suDb.tenant.delete({ where: { id: t } }).catch(() => undefined);
  await su?.$disconnect();
  await app?.$disconnect();
});

// The script as an operator runs it, on the URL given as DATABASE_URL.
async function runScript(tenantId: bigint, databaseUrl: string | undefined) {
  const proc = Bun.spawn(
    [
      "bun",
      "scripts/reprice-usage.ts",
      "--tenant",
      String(tenantId),
      "--provider",
      "deepseek",
      "--model",
      MODEL,
      "--apply",
    ],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

async function ledgerCost(tenantId: bigint): Promise<string | undefined> {
  const [row] = await suDb.$queryRaw<{ cost: string }[]>(Prisma.sql`
    SELECT SUM(cost_usd)::text AS cost FROM llm_usage WHERE tenant_id = ${tenantId}`);
  return row?.cost;
}

describe("what the script prints for a tenant it settled", () => {
  test("settled, with the quarters still read from the rows named apart", () => {
    expect(
      settleReport({
        tenantId: 7n,
        quarters: 10,
        left: 0,
        aboveMark: 2,
        remarked: 1,
      }),
    ).toEqual([
      "tenant 7 · dashboard sums settled for 10 repriced quarters",
      "  2 of them above the dashboard sums' mark: read from the rows until the job sums up to them",
      "  1 of them marked again by later writes: read from the rows until the job settles them",
    ]);
  });

  test("out of time, with the step's last error", () => {
    expect(
      settleReport({
        tenantId: 7n,
        quarters: 10,
        left: 4,
        aboveMark: 0,
        remarked: 0,
        stepError: "Transaction already closed",
      }),
    ).toEqual([
      "tenant 7 · 4 of 10 repriced quarters still marked: the dashboard job settles them, read from the rows until then",
      "  a settle step failed and was retried: Transaction already closed",
    ]);
  });
});

describe.skipIf(!dbUp)(
  "the reprice script settles what it marked (issue #1853)",
  () => {
    test(
      "right after the script returns, no repriced quarter is marked and a 90-day read is the rows' figure",
      async () => {
        expect(await markedQuarters(tA)).toBe(0);
        const { out, err, code } = await runScript(tA, appUrl);
        expect({ code, err }).toEqual({ code: 0, err: "" });
        expect(out).toContain("Wrote 600 rows");
        expect(await markedQuarters(tA)).toBe(0);
        expect(out).toMatch(
          new RegExp(
            `tenant ${tA} · dashboard sums settled for \\d+ repriced quarters`,
          ),
        );
        const read = await costs(tA);
        expect(read).toEqual(await rawCosts(tA));
        expect(read.totalCostUsd).toBeCloseTo(Number(await ledgerCost(tA)), 9);
        expect(read.totalCostUsd).not.toBeCloseTo(600 * Number(WRONG), 3);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "it counts and settles the quarters it repriced, and leaves another tenant's mark to its job",
      async () => {
        const report = await reprice(tA, 0.0123);
        const repriced = await markedQuarters(tA);
        expect(repriced).toBeGreaterThan(0);
        // Concurrent traffic below the mark during the repricing: another tenant's row, and a row of
        // the same tenant in a quarter the repricing did not write.
        await suDb.$executeRaw(Prisma.sql`
        UPDATE llm_usage SET cost_usd = cost_usd + 1
         WHERE id = (SELECT MIN(id) FROM llm_usage WHERE tenant_id = ${tB})`);
        await suDb.llmUsage.create({
          data: {
            tenantId: tA,
            source: "playground",
            model: "other-model",
            costUsd: "0.5",
            createdAt: new Date(FIRST - DAY),
          },
        });
        expect(await markedQuarters(tA)).toBe(repriced + 1);
        expect(await markedQuarters(tB)).toBe(1);

        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          await lastLedgerMarkId(db),
        );
        expect(settled).toEqual({
          tenantId: tA,
          quarters: repriced,
          left: 0,
          aboveMark: 0,
          remarked: 0,
        });
        expect(await markedQuarters(tA)).toBe(0);
        expect(await costs(tA)).toEqual(await rawCosts(tA));
        expect(await markedQuarters(tB)).toBe(1);
        await sumUp(tB);
        expect(await markedQuarters(tB)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a repriced row inside the trigger's grace leaves no mark, and its quarter is reported as read from the rows",
      async () => {
        await suDb.llmUsage.create({
          data: {
            tenantId: tA,
            source: "playground",
            model: MODEL,
            promptTokens: 1_000,
            costUsd: WRONG,
            priceTable: "litellm@0000000old",
            createdAt: new Date(Date.now() - 60_000),
          },
        });
        const report = await reprice(tA, 0.0654);
        const marked = await markedQuarters(tA);
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          await lastLedgerMarkId(db),
        );
        expect(settled).toEqual({
          tenantId: tA,
          quarters: marked + 1,
          left: 0,
          aboveMark: 1,
          remarked: 0,
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "with its time spent it reports what is still marked, and a later write's mark apart, which the job then settles",
      async () => {
        const tF = await seedTenant("r1853-f", 100);
        await sumUp(tF);
        const report = await reprice(tF, 0.0456);
        const marked = await markedQuarters(tF);
        // A quarter the repricing did not write, marked by another writer: not the script's to report.
        await suDb.llmUsage.create({
          data: {
            tenantId: tF,
            source: "playground",
            model: "other-model",
            costUsd: "0.5",
            createdAt: new Date(FIRST - 2 * DAY),
          },
        });
        const upTo = await lastLedgerMarkId(db);
        // A later write on a repriced row, after the settle took its last mark id.
        await suDb.$executeRaw(Prisma.sql`
          UPDATE llm_usage SET cost_usd = cost_usd + 1
           WHERE id = (SELECT MIN(id) FROM llm_usage WHERE tenant_id = ${tF})`);
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          upTo,
          Date.now() - 1,
        );
        expect(settled).toEqual({
          tenantId: tF,
          quarters: marked,
          left: marked,
          aboveMark: 0,
          remarked: 1,
        });
        expect(await costs(tF)).toEqual(await rawCosts(tF));
        await sumUp(tF);
        expect(await markedQuarters(tF)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a step that throws, as one waiting on the job's own step past its budget does, is retried",
      async () => {
        const report = await reprice(tA, 0.0246);
        expect(await markedQuarters(tA)).toBeGreaterThan(0);
        let calls = 0;
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          await lastLedgerMarkId(db),
          undefined,
          async (base, tenantId) => {
            calls += 1;
            if (calls === 1) throw new Error("Transaction already closed");
            return stepLedgerSums(base, tenantId);
          },
        );
        expect(calls).toBeGreaterThan(1);
        expect(settled?.left).toBe(0);
        expect(settled?.stepError).toBe("Transaction already closed");
        expect(await markedQuarters(tA)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "it settles the marks up to the id it is given and leaves later ones to the job",
      async () => {
        const upTo = await lastLedgerMarkId(db);
        const report = await reprice(tA, 0.0987);
        const marked = await markedQuarters(tA);
        expect(marked).toBeGreaterThan(0);
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          upTo,
        );
        expect(settled?.left).toBe(0);
        expect(await markedQuarters(tA)).toBe(marked);
        await sumUp(tA);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "only the quarters of rows it changed are the repricing's: a row already at its price is not",
      async () => {
        const tE = await seedTenant("r1853-e", 2);
        await suDb.$executeRaw(Prisma.sql`
          UPDATE llm_usage SET cost_usd = 0.0111
           WHERE id = (SELECT MIN(id) FROM llm_usage WHERE tenant_id = ${tE})`);
        const rows = await suDb.llmUsage.findMany({
          where: { tenantId: tE },
          orderBy: { id: "asc" },
        });
        const quarter = (at: Date) =>
          at.getTime() - (at.getTime() % (15 * 60 * 1000));
        expect(quarter(rows[0]?.createdAt as Date)).not.toBe(
          quarter(rows[1]?.createdAt as Date),
        );
        const report = await reprice(tE, 0.0111);
        expect(report.written).toBe(1);
        expect([...(report.writtenQuarters.get(tE) ?? [])]).toEqual([
          quarter(rows[1]?.createdAt as Date),
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a tenant its job has not summed yet has its marks cleared and is reported as read from the rows",
      async () => {
        const tC = await seedTenant("r1853-c", 40);
        const { out, code } = await runScript(tC, appUrl);
        expect(code).toBe(0);
        expect(await markedQuarters(tC)).toBe(0);
        expect(out).toMatch(
          new RegExp(
            `^tenant ${tC} · dashboard sums settled for (\\d+) repriced quarters\\n  \\1 of them above the dashboard sums' mark`,
            "m",
          ),
        );
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a repriced quarter from the sums' mark up is reported as read from the rows, the mark's own quarter included",
      async () => {
        const tD = await seedTenant("r1853-d", 200);
        await sumUp(tD);
        // The mark held where it is: a candidate no transaction has reached yet is never waited out.
        const [mid] = await suDb.$queryRaw<{ q: Date }[]>(Prisma.sql`
          SELECT ledger_quarter(created_at) AS q FROM llm_usage
           WHERE tenant_id = ${tD} ORDER BY created_at OFFSET 100 LIMIT 1`);
        await suDb.$executeRaw(Prisma.sql`
          UPDATE ledger_sums_state
             SET summed_until = ${mid?.q}, candidate_at = now(), candidate_xid = '999999999999'::xid8
           WHERE tenant_id = ${tD}`);
        const report = await reprice(tD, 0.0321);
        const [above] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
          SELECT COUNT(DISTINCT quarter)::int AS n FROM ledger_sum_marks
           WHERE tenant_id = ${tD} AND quarter >= ${mid?.q}`);
        const marked = await markedQuarters(tD);
        expect(above?.n).toBeGreaterThan(0);
        expect(above?.n).toBeLessThan(marked);
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          await lastLedgerMarkId(db),
        );
        expect(settled).toEqual({
          tenantId: tD,
          quarters: marked,
          left: 0,
          aboveMark: above?.n ?? -1,
          remarked: 0,
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "without the runtime role's URL, or on a role RLS does not bind, the script writes nothing and says why",
      async () => {
        const cost = await ledgerCost(tB);
        const none = await runScript(tB, undefined);
        expect(none.code).toBe(1);
        expect(none.err).toContain("DATABASE_URL");
        const superuser = await runScript(tB, suUrl);
        expect(superuser.code).toBe(1);
        expect(superuser.err).toContain("SUPERUSER");
        expect(await ledgerCost(tB)).toBe(cost);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "it refuses a connection RLS does not bind, before it touches a mark",
      async () => {
        const report = await reprice(tA, 0.0789);
        const marked = await markedQuarters(tA);
        expect(marked).toBeGreaterThan(0);
        await expect(
          settleRepricedQuarters(
            suDb,
            report.writtenQuarters,
            await lastLedgerMarkId(db),
          ),
        ).rejects.toBeInstanceOf(SuperuserRuntimeError);
        expect(await markedQuarters(tA)).toBe(marked);
        await sumUp(tA);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
