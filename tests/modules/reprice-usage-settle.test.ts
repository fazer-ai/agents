import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import {
  lastLedgerMarkId,
  settleRepricedMarks,
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

describe.skipIf(!dbUp)(
  "the reprice script settles what it marked (issue #1853)",
  () => {
    test(
      "right after the script returns, no repriced quarter is marked and a 90-day read is the rows' figure",
      async () => {
        expect(await markedQuarters(tA)).toBe(0);
        const proc = Bun.spawn(
          [
            "bun",
            "scripts/reprice-usage.ts",
            "--tenant",
            String(tA),
            "--provider",
            "deepseek",
            "--model",
            MODEL,
            "--apply",
          ],
          {
            env: {
              ...process.env,
              MIGRATION_DATABASE_URL: suUrl,
              DATABASE_URL: appUrl,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
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
        const [rows] = await suDb.$queryRaw<{ cost: string }[]>(Prisma.sql`
        SELECT SUM(cost_usd)::text AS cost FROM llm_usage WHERE tenant_id = ${tA}`);
        expect(read.totalCostUsd).toBeCloseTo(Number(rows?.cost), 9);
        expect(read.totalCostUsd).not.toBeCloseTo(600 * Number(WRONG), 3);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "it settles only the marks of the tenants it repriced, and leaves another tenant's mark to its job",
      async () => {
        const before = await lastLedgerMarkId(db);
        await reprice(tA, 0.0123);
        // Concurrent traffic on another tenant, below its mark, during the repricing.
        await suDb.$executeRaw(Prisma.sql`
        UPDATE llm_usage SET cost_usd = cost_usd + 1
         WHERE id = (SELECT MIN(id) FROM llm_usage WHERE tenant_id = ${tB})`);
        const upTo = await lastLedgerMarkId(db);
        const marked = await markedQuarters(tA);
        expect(marked).toBeGreaterThan(0);
        expect(await markedQuarters(tB)).toBe(1);

        const [settled] = await settleRepricedMarks(db, [tA], before, upTo);
        expect(settled).toEqual({ tenantId: tA, quarters: marked, left: 0 });
        expect(await markedQuarters(tA)).toBe(0);
        expect(await costs(tA)).toEqual(await rawCosts(tA));
        expect(await markedQuarters(tB)).toBe(1);
        await sumUp(tB);
        expect(await markedQuarters(tB)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "with its time spent it reports what is still marked, which the job then settles",
      async () => {
        const before = await lastLedgerMarkId(db);
        await reprice(tA, 0.0456);
        const upTo = await lastLedgerMarkId(db);
        const marked = await markedQuarters(tA);
        const [settled] = await settleRepricedMarks(
          db,
          [tA],
          before,
          upTo,
          Date.now() - 1,
        );
        expect(settled).toEqual({
          tenantId: tA,
          quarters: marked,
          left: marked,
        });
        expect(await costs(tA)).toEqual(await rawCosts(tA));
        await sumUp(tA);
        expect(await markedQuarters(tA)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "--apply without the runtime role's URL writes nothing and says why",
      async () => {
        const [before] = await suDb.$queryRaw<{ cost: string }[]>(Prisma.sql`
        SELECT SUM(cost_usd)::text AS cost FROM llm_usage WHERE tenant_id = ${tB}`);
        const proc = Bun.spawn(
          [
            "bun",
            "scripts/reprice-usage.ts",
            "--tenant",
            String(tB),
            "--provider",
            "deepseek",
            "--model",
            MODEL,
            "--apply",
          ],
          {
            env: {
              ...process.env,
              MIGRATION_DATABASE_URL: suUrl,
              DATABASE_URL: "",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [err, code] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code).toBe(1);
        expect(err).toContain("DATABASE_URL");
        const [after] = await suDb.$queryRaw<{ cost: string }[]>(Prisma.sql`
        SELECT SUM(cost_usd)::text AS cost FROM llm_usage WHERE tenant_id = ${tB}`);
        expect(after?.cost).toBe(before?.cost);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "it refuses a connection RLS does not bind, before it touches a mark",
      async () => {
        const before = await lastLedgerMarkId(db);
        await reprice(tA, 0.0789);
        const upTo = await lastLedgerMarkId(db);
        const marked = await markedQuarters(tA);
        expect(marked).toBeGreaterThan(0);
        await expect(
          settleRepricedMarks(suDb, [tA], before, upTo),
        ).rejects.toBeInstanceOf(SuperuserRuntimeError);
        expect(await markedQuarters(tA)).toBe(marked);
        await sumUp(tA);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
