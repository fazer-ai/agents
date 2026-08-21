import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";

// `tool_definitions.risk_tier` is retired (issue #137) and comes out one release after the schema
// stopped naming it (issue #149). What makes that drop safe is NOT that no code reads the value: it
// is that no query this build sends NAMES the column, because an operator who rolls back, or whose
// platform overlaps containers during a rolling deploy, runs THIS build against a database where
// the column is already gone.
//
// The two are easy to confuse, and the first attempt at #149 did: it read the tool-definitions
// service's explicit SELECT list, found nothing, and concluded the column was unnamed. A Prisma
// query without an explicit `select` asks for every scalar column of the model, and a relation
// pulled in as `toolDefinition: true` does the same, so three queries were naming it.
//
// `@ignore` on the field is what fixes that, and it is checked here rather than trusted: it removes
// the field from the generated client, so the column cannot appear in any query shape and reading it
// does not compile. The cases below are the four shapes that were, or could have been, naming it.

// Driven with the migration role, which is not subject to row security. What is under test is the
// SQL the CLIENT composes, which the connecting role does not change, and the alternative is that a
// write rejected by RLS emits no query event at all (Prisma only reports statements that succeeded),
// so the insert below would silently assert on an empty list.
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let client: PrismaClient | undefined;
let tenantId = 0n;
const sql: string[] = [];
if (suUrl) {
  try {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
      log: [{ emit: "event", level: "query" }],
    });
    // @ts-expect-error the event map is only typed when `log` is a literal on the constructor type
    client.$on("query", (e: { query: string }) => sql.push(e.query));
    await client.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const db = client as PrismaClient;

beforeAll(async () => {
  if (!dbUp) return;
  const tenant = await db.tenant.create({
    data: { name: "RT", slug: `rt-${process.pid}` },
  });
  tenantId = tenant.id;
});

afterAll(async () => {
  if (dbUp && tenantId) {
    await db.tenant.delete({ where: { id: tenantId } });
  }
  await client?.$disconnect();
});

// What is under test is the SQL the client SENDS, not what comes back, so the reads below match
// nothing on purpose. The insert is the exception: a statement the database rejects emits no query
// event, so it has to succeed, and it is cleaned up with the tenant it hangs off.
const sqlFor = async (fn: () => Promise<unknown>): Promise<string[]> => {
  sql.length = 0;
  await fn().catch(() => undefined);
  return sql.filter((q) => q.includes("tool_definitions"));
};

describe.skipIf(!dbUp)("no query names the retired column", () => {
  test("a read that lets Prisma choose the columns", async () => {
    const queries = await sqlFor(() =>
      db.toolDefinition.findMany({ where: { id: { in: [-1n] } } }),
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes("risk_tier"))).toBe(false);
  });

  test("a write whose returned row nobody reads", async () => {
    const queries = await sqlFor(() =>
      db.toolDefinition.update({ where: { id: -1n }, data: { label: "x" } }),
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes("risk_tier"))).toBe(false);
  });

  // The shape that matches no call-site pattern, so no source-level guard would find it, and the one
  // the customer-facing turn path uses to load an agent's granted tools.
  test("a relation pulled in whole", async () => {
    const queries = await sqlFor(() =>
      db.agentToolSelection.findMany({
        where: { agentId: -1n },
        include: { toolDefinition: true },
      }),
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes("risk_tier"))).toBe(false);
  });

  // An INSERT names its columns too, and this one is reached by importing an agent bundle. The row
  // still gets the column's default in the database; it is the statement that must not mention it.
  test("an insert", async () => {
    const queries = await sqlFor(() =>
      db.toolDefinition.create({
        data: {
          tenantId,
          name: `probe-${process.pid}`,
          label: "probe",
          urlTemplate: "https://example.invalid",
          allowedHosts: [],
        },
      }),
    );
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes("risk_tier"))).toBe(false);
  });

  // The control. Without it every assertion above would also pass on a client that had stopped
  // querying this table at all, or on a filter that stopped matching the table's name.
  test("and the check itself can see the column when it is there", async () => {
    const queries = await sqlFor(
      () => db.$queryRaw`SELECT risk_tier FROM tool_definitions WHERE id = -1`,
    );
    expect(queries.some((q) => q.includes("risk_tier"))).toBe(true);
  });
});
