import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Client } from "pg";

// A BARE `@@index([tenantId])` BESIDE A COMPOSITE THAT LEADS WITH `tenantId` (issue #373).
//
// A btree serves any leading prefix of its columns, so `(tenant_id, x)` already answers
// `WHERE tenant_id = $1`; a second index on `(tenant_id)` alone adds a row to maintain on every
// insert and on every non-HOT update, and answers nothing the first one could not.
//
// Measured on PostgreSQL 17.10 against 1,000,000 seeded delivery rows across 50 tenants, with the
// bare index dropped inside a rolled-back transaction so both arms saw the same table:
//
//   INSERT  +3.0 buffer accesses per row      UPDATE  +4.0 buffer accesses per row
//
// and `n_tup_hot_upd = 0` on both tables under test, so no update escapes index maintenance. On the
// read side every plan the codebase actually issues came out identical, because the composite takes
// over the prefix scan; only a bare `count(*)` per tenant reads more index pages (21 -> 193), and
// there is no such query on either table.
//
// UNIQUENESS IS NOT PART OF THE RULE, and getting that wrong is what made the issue's own count say
// two models when the schema held eighteen. `@@unique([tenantId, ...])` is a unique btree, and a
// unique btree serves the prefix exactly like a plain one — measured by leaving
// `issued_documents_tenant_id_idempotency_key_key` as the only tenant-led index on the table and
// watching the planner take it with `Index Cond: (tenant_id = 7)`.
//
// THERE IS NO WAIVER LIST HERE ON PURPOSE. A ledger says "this shape is the exception", and no
// model on either side of this rule is: the composite covers the prefix or it does not, and that is
// a property of the index, not of the model's circumstances. A model that needs the bare index back
// needs a measurement, and the measurement belongs in the schema next to it.

type Model = { name: string; indexes: { unique: boolean; cols: string[] }[] };

function parseModels(schema: string): Model[] {
  return [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
    ([, name, body]) => ({
      name: name as string,
      indexes: [
        ...(body ?? "").matchAll(/@@(index|unique)\(\[([^\]]*)\]/g),
      ].map(([, kind, cols]) => ({
        unique: kind === "unique",
        cols: (cols ?? "").split(",").map((c) => c.trim()),
      })),
    }),
  );
}

const models = parseModels(readFileSync("prisma/schema.prisma", "utf8"));

describe("no bare tenantId index sits beside a composite that already covers it", () => {
  test("the schema declares none", () => {
    // A sweep that finds nothing is a broken sweep, not a clean repo: this regex has to keep
    // matching the file for the assertion below to mean anything.
    const bare = models.filter((m) =>
      m.indexes.some(
        (i) => !i.unique && i.cols.length === 1 && i.cols[0] === "tenantId",
      ),
    );
    expect(bare.length).toBeGreaterThan(5);

    const covered = bare.filter((m) =>
      m.indexes.some((i) => i.cols.length > 1 && i.cols[0] === "tenantId"),
    );
    expect(covered.map((m) => m.name)).toEqual([]);
  });
});

describe("a concurrent index drop is alone in its migration", () => {
  // The eighteen drops are one per file, and that is not a style choice: measured through
  // `prisma migrate deploy` against scratch databases, a `DROP INDEX CONCURRENTLY` applies when it
  // is the only statement in the file and fails with `cannot run inside a transaction block` as
  // soon as ANY second statement joins it. `CREATE INDEX CONCURRENTLY` does not share the limit,
  // which is why a neighbouring migration can use it beside other statements.
  //
  // Without this, merging two of those files back together is caught by nothing until a release
  // deploy runs the migration and stops.
  test("every file that drops one concurrently holds one statement", () => {
    const dir = "prisma/migrations";
    const offenders: string[] = [];
    let concurrent = 0;
    for (const name of readdirSync(dir)) {
      const file = `${dir}/${name}/migration.sql`;
      if (!existsSync(file)) continue;
      const sql = readFileSync(file, "utf8");
      // Comments carry semicolons of their own, and a comment is not a statement.
      const statements = sql
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .split(";")
        .filter((s) => s.trim().length > 0);
      if (!/DROP\s+INDEX\s+CONCURRENTLY/i.test(sql)) continue;
      concurrent += 1;
      if (statements.length !== 1)
        offenders.push(`${name} (${statements.length} statements)`);
    }
    // The control: no file matching means the sweep is broken, not that the rule holds.
    expect(concurrent).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

const suUrl = process.env.MIGRATION_DATABASE_URL;
let su: Client | undefined;
let dbUp = false;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;

describe.skipIf(!dbUp)("and a database built from it holds none either", () => {
  // Opened at module load, so it outlives a `describe` that never runs: an open TCP handle can keep
  // `bun test` alive past the last assertion.
  afterAll(async () => {
    await su?.end();
  });

  // The schema test reads the file; this one reads the catalog, which is what the migration
  // actually produced. A `DROP INDEX` left out of the migration passes the first and fails here.
  //
  // ONE query answers both halves on purpose. Asked only for offenders it returns an empty array
  // for a clean catalog AND for a query that matches nothing — mutating the tenant column name to
  // one that does not exist left the whole file green. Listing every tenant-led index and doing the
  // pairing here means a broken column extraction empties the control in the same breath.
  test("no table carries one", async () => {
    const { rows } = await suDb.query<{
      table: string;
      index: string;
      cols: string[];
    }>(`
      SELECT i.indrelid::regclass::text AS table,
             c.relname                  AS index,
             -- Key columns only (indnkeyatts), and by position, so an INCLUDE column never reads as
             -- part of the prefix a scan can use.
             (SELECT array_agg(pg_get_indexdef(i.indexrelid, k, true) ORDER BY k)
                FROM generate_series(1, i.indnkeyatts) k) AS cols
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
       WHERE am.amname = 'btree'
         AND i.indpred IS NULL
         AND c.relnamespace = 'public'::regnamespace
       ORDER BY 1, 2`);

    const tenantLed = rows.filter((r) => r.cols?.[0] === "tenant_id");
    // The control: a catalog this sweep cannot read looks exactly like a catalog with nothing to
    // report. Thirty-odd tables are tenant-scoped, so a handful is already a broken sweep.
    expect(tenantLed.length).toBeGreaterThan(20);
    expect(
      tenantLed.find(
        (r) =>
          r.index === "outbound_webhook_deliveries_tenant_id_status_id_idx",
      )?.cols,
    ).toEqual(["tenant_id", "status", "id"]);

    const covered = new Set(
      tenantLed.filter((r) => r.cols.length > 1).map((r) => r.table),
    );
    const redundant = tenantLed.filter(
      (r) => r.cols.length === 1 && covered.has(r.table),
    );
    expect(redundant.map((r) => `${r.table}.${r.index}`)).toEqual([]);
  });

  // The other half of the drop: what is supposed to answer the prefix scan now has to still be
  // there. A migration that dropped the composite instead would satisfy the test above.
  test("the composites that take over are present", async () => {
    const { rows } = await suDb.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'outbound_webhook_deliveries_tenant_id_id_idx',
         'outbound_webhook_deliveries_tenant_id_status_id_idx',
         'issued_documents_tenant_id_thread_id_idx',
         'issued_documents_tenant_id_template_id_idx',
         'contacts_tenant_id_chatwoot_instance_id_chatwoot_contact_id_key')
       ORDER BY 1`);
    expect(rows.length).toBe(5);
  });
});
