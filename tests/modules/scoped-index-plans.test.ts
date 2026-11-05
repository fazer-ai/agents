import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import { followUpSweepSelectionSql } from "@/modules/followups/handlers";
import { snoozedSweepSelectionSql } from "@/modules/followups/snoozed";
import { dbProbeFailed } from "@/tests/db-gate";

// Under the tenant policy an enum predicate never reaches an index (enum equality is not LEAKPROOF,
// docs/tenancy.md), so a selection matching its job by (tenant_id, kind, dedupe_key) walks every kind
// of the tenant per candidate: 8.4 s against a 5 s budget, measured in production. The plan is read as
// the app role with the tenant set: every read of scheduler_jobs is an index scan whose condition
// binds the index's leading columns through dedupe_key. With only the unique index, `kind` is the
// column the condition skips, and without the OFFSET 0 fence the planner hashes the whole tenant.
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

// Enough rows of another kind that the planner picks an index over a scan, as it does in production.
const OTHER_KIND_ROWS = 30_000;
let tenantId = 0n;
let agentId = 0n;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

function nodesOn(node: PlanNode, relation: string): PlanNode[] {
  const own = node["Relation Name"] === relation ? [node] : [];
  return [...own, ...(node.Plans ?? []).flatMap((p) => nodesOn(p, relation))];
}

async function planOf(sql: Prisma.Sql): Promise<PlanNode> {
  const rows = await runScopedOn(
    appDb,
    { tenantId, userId: null, role: "TENANT_ADMIN" },
    (db) =>
      db.$queryRaw<{ "QUERY PLAN": [{ Plan: PlanNode }] }[]>(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`,
      ),
  );
  const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
  console.log(
    JSON.stringify(
      plan,
      (k, v) =>
        [
          "Plans",
          "Node Type",
          "Relation Name",
          "Index Name",
          "Index Cond",
          "Filter",
          "Join Type",
          "Plan Rows",
          "Hash Cond",
          "Subplan Name",
          "Parent Relationship",
        ].includes(k) ||
        /^[0-9]+$/.test(k) ||
        k === ""
          ? v
          : undefined,
      1,
    ),
  );
  if (!plan) throw new Error("no plan");
  return plan;
}

async function indexColumns(name: string): Promise<string[]> {
  const rows = await suDb.$queryRaw<{ col: string }[]>`
    SELECT a.attname AS col
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     WHERE c.relname = ${name}
     ORDER BY k.ord`;
  return rows.map((r) => r.col);
}

// Every read of scheduler_jobs by dedupe key is an index scan whose condition binds each column of the
// index up to dedupe_key: a skipped leading column (kind) means the scan walks it.
async function expectDedupeLookups(plan: PlanNode): Promise<void> {
  const reads = nodesOn(plan, "scheduler_jobs");
  expect(reads.length).toBeGreaterThan(0);
  for (const node of reads) {
    expect(node["Node Type"]).not.toBe("Seq Scan");
    const cond = node["Index Cond"] ?? "";
    expect(cond).toContain("dedupe_key");
    const cols = await indexColumns(node["Index Name"] ?? "");
    const prefix = cols.slice(0, cols.indexOf("dedupe_key") + 1);
    expect(prefix.length).toBeGreaterThan(0);
    for (const col of prefix) expect(cond).toContain(col);
  }
}

describe.skipIf(!dbUp)(
  "the follow-up sweep selections reach their index under the tenant policy",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Plans 1700", slug: `plans1700-${process.pid}` },
      });
      tenantId = t.id;
      const a = await suDb.agent.create({
        data: {
          tenantId,
          name: "plans",
          systemPrompt: "x",
          followUpArmedAt: new Date(),
          snoozedFollowUpArmedAt: new Date(),
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
        select: { id: true },
      });
      agentId = a.id;
      await suDb.$executeRaw`
        INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, payload, status, run_at, updated_at)
        SELECT ${tenantId}, 'OBSERVE', 'observe:plans:' || g, '{}'::jsonb, 'DONE', now(), now()
          FROM generate_series(1, ${OTHER_KIND_ROWS}) AS g`;
      await suDb.$executeRawUnsafe("ANALYZE scheduler_jobs");
    });

    afterAll(async () => {
      await suDb.schedulerJob.deleteMany({ where: { tenantId } });
      await suDb.agent.deleteMany({ where: { tenantId } });
      await suDb.tenant.delete({ where: { id: tenantId } });
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("the snoozed selection", async () => {
      const plan = await planOf(
        snoozedSweepSelectionSql(tenantId, [agentId], new Date()),
      );
      await expectDedupeLookups(plan);
    });

    test("the inactivity selection", async () => {
      const now = new Date();
      const plan = await planOf(
        followUpSweepSelectionSql({
          tenantId,
          followUpAgentIds: [agentId],
          unfencedAgentIds: [],
          cutoff: new Date(now.getTime() - 15 * 60_000),
          now,
        }),
      );
      await expectDedupeLookups(plan);
    });
  },
);
