import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import {
  RepriceWriteError,
  readWithRetry,
  repriceAndSettle,
  type SettledTenant,
  settleFailed,
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
const suUrl = process.env.TEST_MIGRATION_DATABASE_URL;
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

async function seedTenant(
  slug: string,
  rows: number,
  first = FIRST,
): Promise<bigint> {
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
      createdAt: new Date(first + Math.floor(((LAST - first) * i) / rows)),
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
      // Killed before the test's own timeout, so a run that hangs never outlives its test.
      timeout: 25_000,
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

  test("what is left unread, which exits 1 like a mark left", () => {
    expect(
      settleReport({
        tenantId: 7n,
        quarters: 10,
        left: 0,
        aboveMark: 0,
        remarked: 0,
        unread: "lock timeout",
      }),
    ).toEqual([
      "tenant 7 · what is still marked of 10 repriced quarters could not be read (lock timeout): the dashboard job settles them, read from the rows until then",
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
      "  a settle read or step failed: Transaction already closed",
    ]);
  });
});

describe("the run's exit", () => {
  const t = {
    tenantId: 7n,
    quarters: 10,
    left: 0,
    aboveMark: 3,
    remarked: 2,
  } satisfies SettledTenant;
  test("is 0 with only quarters above the mark or marked again", () => {
    expect(settleFailed([t])).toBe(false);
  });
  test("is 1 with a mark left, or with what is left unread", () => {
    expect(settleFailed([t, { ...t, left: 1 }])).toBe(true);
    expect(settleFailed([t, { ...t, unread: "lock timeout" }])).toBe(true);
  });
});

describe("a read of the marks before or after the steps", () => {
  test("is tried again a retry time apart, and answers once it succeeds", async () => {
    const slept: number[] = [];
    let tries = 0;
    const read = await readWithRetry(
      async () => {
        tries += 1;
        if (tries < 3) throw new Error("lock timeout");
        return "marks";
      },
      async (ms) => {
        slept.push(ms);
      },
    );
    expect(read).toEqual({ ok: true, value: "marks" });
    expect(slept).toEqual([1000, 1000]);
  });

  test("does not retry an error it is told is final", async () => {
    let tries = 0;
    const refusal = new Error("the role is a superuser");
    await expect(
      readWithRetry(
        async () => {
          tries += 1;
          throw refusal;
        },
        async () => {},
        (err) => err === refusal,
      ),
    ).rejects.toBe(refusal);
    expect(tries).toBe(1);
  });

  test("gives up after three tries with the last error", async () => {
    let tries = 0;
    const read = await readWithRetry(
      async () => {
        tries += 1;
        throw new Error(`lock timeout ${tries}`);
      },
      async () => {},
    );
    expect(read).toEqual({ ok: false, error: "lock timeout 3" });
    expect(tries).toBe(3);
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
        const tJ = await seedTenant("r1853-j", 50);
        await sumUp(tJ);
        await suDb.llmUsage.create({
          data: {
            tenantId: tJ,
            source: "playground",
            model: MODEL,
            promptTokens: 1_000,
            costUsd: WRONG,
            priceTable: "litellm@0000000old",
            createdAt: new Date(Date.now() - 60_000),
          },
        });
        const report = await reprice(tJ, 0.0654);
        const marked = await markedQuarters(tJ);
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
        );
        expect(settled).toEqual({
          tenantId: tJ,
          quarters: marked + 1,
          left: 0,
          aboveMark: 1,
          remarked: 0,
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "with its time spent it reports what is still marked, which the job then settles",
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
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          { deadline: Date.now() - 1 },
        );
        expect(settled).toEqual({
          tenantId: tF,
          quarters: marked,
          left: marked,
          aboveMark: 0,
          remarked: 0,
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
        // The steps taken before each sleep the settle asks for, on a clock the sleep moves.
        const slept: [number, number][] = [];
        let clock = 0;
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          {
            now: () => clock,
            sleep: async (ms) => {
              slept.push([calls, ms]);
              clock += ms;
            },
            step: async (base, tenantId) => {
              calls += 1;
              if (calls === 1) throw new Error("Transaction already closed");
              return stepLedgerSums(base, tenantId);
            },
          },
        );
        expect(calls).toBeGreaterThan(2);
        // The tenant waits its retry time once, after the failure, and not after a success.
        expect(slept).toEqual([[1, 1000]]);
        expect(settled?.left).toBe(0);
        expect(settled?.stepError).toBe("Transaction already closed");
        expect(await markedQuarters(tA)).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a write that commits on a settled tenant while the next one settles is reported as marked again, whatever its mark's id",
      async () => {
        // Twenty days of calls, so its steps outlast the first tenant's four days.
        const tG = await seedTenant("r1853-g", 200, NOW - 20 * DAY);
        await sumUp(tG);
        // A write in a quarter the repricing writes, on a row it does not, open from before the
        // repricing: its mark's id is taken now, below the cutoff, and becomes visible when it commits.
        const [near] = await suDb.$queryRaw<{ at: Date }[]>(Prisma.sql`
          SELECT MIN(created_at) AS at FROM llm_usage WHERE tenant_id = ${tA} AND model = ${MODEL}`);
        const other = await suDb.llmUsage.create({
          data: {
            tenantId: tA,
            source: "playground",
            model: "other-model",
            costUsd: "0.5",
            createdAt: near?.at as Date,
          },
        });
        let commit = () => {};
        const committed = new Promise<void>((r) => {
          commit = r;
        });
        let opened = () => {};
        const isOpen = new Promise<void>((r) => {
          opened = r;
        });
        const writer = suDb.$transaction(
          async (tx) => {
            await tx.$executeRaw(Prisma.sql`
              UPDATE llm_usage SET prompt_tokens = prompt_tokens + 1 WHERE id = ${other.id}`);
            opened();
            await committed;
          },
          { timeout: 60_000 },
        );
        let wrote = false;
        // One step per tenant per round: two steps of the second tenant in a row mean the first one
        // has left the rounds, settled.
        let last: bigint | undefined;
        let settledA: SettledTenant | undefined;
        let settledG: SettledTenant | undefined;
        try {
          // The writer failing to open fails the test here, instead of a wait on a latch.
          await Promise.race([isOpen, writer]);
          const a = await reprice(tA, 0.0135);
          const g = await reprice(tG, 0.0135);
          const written = new Map([...a.writtenQuarters, ...g.writtenQuarters]);
          [settledA, settledG] = await settleRepricedQuarters(db, written, {
            step: async (base, tenantId) => {
              if (tenantId === tG && last === tG && !wrote) {
                wrote = true;
                commit();
                await writer;
              }
              last = tenantId;
              return stepLedgerSums(base, tenantId);
            },
          });
        } finally {
          // Released whatever the settle did: an open writer holds back every later sum.
          commit();
          await writer;
        }
        expect(wrote).toBe(true);
        expect(settledA).toMatchObject({ tenantId: tA, left: 0, remarked: 1 });
        expect(settledG).toMatchObject({ tenantId: tG, left: 0, remarked: 0 });
        await sumUp(tA);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "no step starts after the budget runs out, even inside a round",
      async () => {
        const tI = await seedTenant("r1853-i", 20, NOW - DAY);
        await sumUp(tI);
        const a = await reprice(tA, 0.0468);
        const i = await reprice(tI, 0.0468);
        const stepped: bigint[] = [];
        // A clock the step moves past the deadline, as a step that outlasts the budget does.
        let clock = 0;
        const [, settledI] = await settleRepricedQuarters(
          db,
          new Map([...a.writtenQuarters, ...i.writtenQuarters]),
          {
            now: () => clock,
            deadline: 100,
            step: async (base, tenantId) => {
              stepped.push(tenantId);
              clock = 200;
              return stepLedgerSums(base, tenantId);
            },
          },
        );
        expect(stepped).toEqual([tA]);
        expect(settledI?.left).toBeGreaterThan(0);
        await sumUp(tA);
        await sumUp(tI);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a budget that runs out while it reads the marks starts no step",
      async () => {
        const report = await reprice(tA, 0.0579);
        let ticks = 0;
        let steps = 0;
        const [settled] = await settleRepricedQuarters(
          db,
          report.writtenQuarters,
          {
            // The checks before the read of the marks see time left, the one after it does not.
            now: () => ticks++,
            deadline: 2,
            step: async (base, tenantId) => {
              steps += 1;
              return stepLedgerSums(base, tenantId);
            },
          },
        );
        expect(steps).toBe(0);
        expect(settled?.left).toBeGreaterThan(0);
        await sumUp(tA);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a tenant whose steps keep failing does not keep another from settling",
      async () => {
        const tH = await seedTenant("r1853-h", 20, NOW - DAY);
        await sumUp(tH);
        const a = await reprice(tA, 0.0357);
        const h = await reprice(tH, 0.0357);
        let failures = 0;
        let clock = 0;
        let sleeps = 0;
        // The sleeps the settle had asked for at each of the healthy tenant's steps.
        const sleptBeforeH: number[] = [];
        const [settledA, settledH] = await settleRepricedQuarters(
          db,
          new Map([...a.writtenQuarters, ...h.writtenQuarters]),
          {
            now: () => clock,
            deadline: 5_000,
            sleep: async (ms) => {
              sleeps += 1;
              clock += ms;
            },
            step: async (base, tenantId) => {
              if (tenantId === tA) {
                failures += 1;
                throw new Error("Transaction already closed");
              }
              sleptBeforeH.push(sleeps);
              return stepLedgerSums(base, tenantId);
            },
          },
        );
        expect(settledH).toMatchObject({ tenantId: tH, left: 0 });
        // The healthy tenant never waits on the failing one's retry time.
        expect(sleptBeforeH.length).toBeGreaterThan(0);
        expect(sleptBeforeH.every((n) => n === 0)).toBe(true);
        // The failing tenant is retried once per retry time, not in a spin.
        expect(failures).toBe(5);
        expect(settledA?.left).toBeGreaterThan(0);
        expect(settledA?.stepError).toBe("Transaction already closed");
        await sumUp(tA);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a repricing that fails after some batches committed settles those before it throws",
      async () => {
        const tK = await seedTenant("r1853-k", 40);
        await sumUp(tK);
        let priced = 0;
        const failed = await repriceAndSettle(db, {
          tenant: tK,
          provider: "deepseek",
          model: MODEL,
          apply: true,
          batchSize: 10,
          stamp: "litellm@test-partial",
          price: () => {
            priced += 1;
            if (priced > 20) throw new Error("lock timeout");
            return 0.0222;
          },
        }).catch((err: unknown) => err);
        expect(failed).toBeInstanceOf(RepriceWriteError);
        const [settled] = (failed as RepriceWriteError).settled;
        expect(settled?.tenantId).toBe(tK);
        expect(settled?.quarters).toBeGreaterThan(0);
        expect(settled?.left).toBe(0);
        const written = await suDb.llmUsage.count({
          where: { tenantId: tK, priceTable: "litellm@test-partial" },
        });
        expect(written).toBe(20);
        expect(await markedQuarters(tK)).toBe(0);
        expect(await costs(tK)).toEqual(await rawCosts(tK));
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
          settleRepricedQuarters(suDb, report.writtenQuarters),
        ).rejects.toBeInstanceOf(SuperuserRuntimeError);
        expect(await markedQuarters(tA)).toBe(marked);
        await sumUp(tA);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
