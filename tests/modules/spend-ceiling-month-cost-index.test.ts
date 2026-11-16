import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { monthStart } from "@/modules/spend-ceiling/decide";
import { pollTenantSpend } from "@/modules/spend-ceiling/poll";
import { dbProbeFailed } from "@/tests/db-gate";

// THE MONTH'S COST OF ONE SOURCE COMES FROM AN INDEX, AND IS STILL THE LEDGER'S. The poll sums
// `cost_usd` by tenant, source and calendar month every minute; on a ledger with half a million rows
// in the month, a read that visits each row's heap page costs 300k buffers per poll. What is pinned
// here: the poll's own statement, as the runtime role runs it under RLS, is answered by an index-only
// scan of `llm_usage_tenant_id_source_created_at_cost_usd_idx`; the figure it writes is the raw sum of
// the ledger read with every index turned off, through the month and as rows arrive; and the table
// carries the insert trigger that keeps the visibility map, which the index-only scan needs, current.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
const INDEX = "llm_usage_tenant_id_source_created_at_cost_usd_idx";
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
const queries: { query: string; params: string }[] = [];
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    const logged = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
      log: [{ emit: "event", level: "query" }] as const,
    });
    logged.$on("query", (e) =>
      queries.push({ query: e.query, params: e.params }),
    );
    await logged.$queryRaw`SELECT 1`;
    app = logged as unknown as PrismaClient;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const NOW = new Date("2026-08-15T12:00:00Z");
let tenantId = 0n;
let otherTenant = 0n;

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
};
const nodes = (n: PlanNode): PlanNode[] => [
  n,
  ...(n.Plans ?? []).flatMap(nodes),
];

async function seed(
  tenant: bigint,
  rows: { cost: string | null; source?: string; at: Date }[],
) {
  await suDb.llmUsage.createMany({
    data: rows.map((r) => ({
      tenantId: tenant,
      model: "m",
      source: r.source ?? "inbox",
      costUsd: r.cost ?? undefined,
      createdAt: r.at,
    })),
  });
}

const snapshotCost = async (source: string) =>
  (
    await suDb.spendCostSnapshot.findUnique({
      where: {
        tenantId_source_monthStart: {
          tenantId,
          source,
          monthStart: monthStart(NOW),
        },
      },
      select: { costUsd: true },
    })
  )?.costUsd?.toString();

// The ledger's own sum, read as the runtime role under the tenant's RLS scope with every index path
// turned off, so it cannot come from the index under test.
async function rawSum(source: string): Promise<string> {
  const role = new URL(appUrl as string).username;
  let sum = "";
  await suDb
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_indexonlyscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      const [row] = await tx.$queryRaw<{ s: Prisma.Decimal | null }[]>`
        SELECT SUM(cost_usd) AS s FROM llm_usage
         WHERE source = ${source}
           AND created_at >= ${monthStart(NOW)}
           AND created_at < ${new Date("2026-09-01T00:00:00Z")}`;
      sum = Number(row?.s ?? 0).toString();
      throw new Error("rollback");
    })
    .catch((e) => {
      if ((e as Error).message !== "rollback") throw e;
    });
  return sum;
}

describe.skipIf(!dbUp)("the month's cost of one source", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MCI", slug: `mci-${process.pid}` },
    });
    const o = await suDb.tenant.create({
      data: { name: "MCI-other", slug: `mci-o-${process.pid}` },
    });
    tenantId = t.id;
    otherTenant = o.id;
    await seed(tenantId, [
      { cost: "0.100001", at: new Date("2026-08-01T00:00:00Z") },
      { cost: "0.2", at: new Date("2026-08-10T08:30:00Z") },
      { cost: null, at: new Date("2026-08-11T00:00:00Z") },
      {
        cost: "1.25",
        source: "playground",
        at: new Date("2026-08-12T00:00:00Z"),
      },
      { cost: "9", at: new Date("2026-07-31T23:59:59.999Z") },
      { cost: "9", at: new Date("2026-09-01T00:00:00Z") },
    ]);
    await seed(otherTenant, [{ cost: "7", at: NOW }]);
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const id of [tenantId, otherTenant]) {
      await suDb.spendCostSnapshot.deleteMany({ where: { tenantId: id } });
      await suDb.llmUsage.deleteMany({ where: { tenantId: id } });
      await suDb.tenant.delete({ where: { id } });
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the poll's own sum, run as the runtime role, is an index-only scan of the month's-cost index", async () => {
    queries.length = 0;
    expect(await pollTenantSpend(tenantId, { base: appDb, now: NOW })).toEqual({
      status: "polled",
    });
    const sums = queries.filter(
      (q) => /\bSUM\(/.test(q.query) && /"llm_usage"/.test(q.query),
    );
    expect(sums.length).toBeGreaterThan(0);
    const { query, params } = sums[0] as { query: string; params: string };
    const values = JSON.parse(params) as unknown[];
    const role = new URL(appUrl as string).username;
    let plan: PlanNode | undefined;
    // Every other index of the ledger dropped in a transaction that rolls back, and sequential scans
    // priced out: what is left asks only whether the statement's own predicate reaches the index.
    await suDb
      .$transaction(async (tx) => {
        const others = await tx.$queryRaw<{ name: string }[]>`
          SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           WHERE i.indrelid = 'llm_usage'::regclass AND NOT i.indisprimary
             AND c.relname <> ${INDEX}`;
        for (const o of others)
          await tx.$executeRawUnsafe(`DROP INDEX "${o.name}"`);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        const [row] = await tx.$queryRawUnsafe<
          { "QUERY PLAN": [{ Plan: PlanNode }] }[]
        >(`EXPLAIN (FORMAT JSON) ${query}`, ...values);
        plan = row?.["QUERY PLAN"][0].Plan;
        throw new Error("rollback");
      })
      .catch((e) => {
        if ((e as Error).message !== "rollback") throw e;
      });
    const scans = nodes(plan as PlanNode).filter(
      (n) => n["Relation Name"] === "llm_usage",
    );
    expect(scans.map((n) => [n["Node Type"], n["Index Name"]])).toEqual([
      ["Index Only Scan", INDEX],
    ]);
    // The source before the month, or a sparse source's sum walks every row of the busy one in the
    // same window: the plan above reads the same for both orders.
    const [def] = await suDb.$queryRaw<{ def: string }[]>`
      SELECT pg_get_indexdef(${INDEX}::regclass) AS def`;
    expect(def?.def).toContain("(tenant_id, source, created_at, cost_usd)");
  });

  test("the figure is the raw sum of the ledger, and only grows inside the month as rows arrive", async () => {
    await pollTenantSpend(tenantId, { base: appDb, now: NOW });
    const first = await snapshotCost("inbox");
    expect(first).toBe("0.300001");
    expect(first).toBe(await rawSum("inbox"));
    expect(await snapshotCost("playground")).toBe(await rawSum("playground"));
    expect(await snapshotCost("playground")).toBe("1.25");

    await seed(tenantId, [
      { cost: "0.000001", at: new Date("2026-08-15T11:59:00Z") },
      { cost: null, at: new Date("2026-08-15T11:59:30Z") },
    ]);
    await pollTenantSpend(tenantId, {
      base: appDb,
      now: new Date(NOW.getTime() + 60_000),
    });
    const second = await snapshotCost("inbox");
    expect(second).toBe(await rawSum("inbox"));
    expect(Number(second)).toBeGreaterThan(Number(first));
    expect(second).toBe("0.300002");
  });

  test("the ledger's autovacuum runs on a fixed insert trigger, whatever the table's size", async () => {
    const [row] = await suDb.$queryRaw<{ opts: string[] | null }[]>`
      SELECT reloptions AS opts FROM pg_class WHERE oid = 'llm_usage'::regclass`;
    expect(row?.opts ?? []).toEqual(
      expect.arrayContaining([
        "autovacuum_vacuum_insert_threshold=10000",
        "autovacuum_vacuum_insert_scale_factor=0",
      ]),
    );
  });
});
