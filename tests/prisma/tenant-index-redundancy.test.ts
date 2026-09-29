import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Client } from "pg";

// A BARE `@@index([tenantId])` BESIDE A COMPOSITE THAT LEADS WITH `tenantId` is refused. A btree
// serves any leading prefix of its columns, so `(tenant_id, x)` already answers
// `WHERE tenant_id = $1`; the bare index adds a row to maintain on every insert and non-HOT update
// and answers nothing the composite could not. A UNIQUE composite counts too: a unique btree serves
// the prefix exactly like a plain one. There is NO WAIVER LIST on purpose: covering the prefix is a
// property of the index, not of the model's circumstances, so a model that needs the bare index
// back needs a measurement, written in the schema next to it.

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
  // NOTE: The eighteen drops are one per file because under `prisma migrate deploy` a
  // `DROP INDEX CONCURRENTLY` fails with `cannot run inside a transaction block` as soon as ANY second
  // statement joins it (`CREATE INDEX CONCURRENTLY` has no such limit). Nothing else catches two of
  // them merged into one file before a release deploy stops on it.
  test("every file that drops one concurrently holds one statement", () => {
    const dir = "prisma/migrations";
    const offenders: string[] = [];
    let concurrent = 0;
    for (const name of readdirSync(dir)) {
      const file = `${dir}/${name}/migration.sql`;
      if (!existsSync(file)) continue;
      // TWO KINDS OF TEXT THAT ARE NOT STATEMENTS. A comment carries semicolons and can NAME the
      // command it explains, so a header describing this rule would read as breaking it. A `DO $$ … $$`
      // block is ONE statement holding several semicolons (and here, a RAISE naming a command). Both are
      // stripped once, and what is left answers both questions: which file, and how many statements.
      const sql = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .replace(/\$\$[\s\S]*?\$\$/g, "$$BODY$$");
      const statements = sql.split(";").filter((s) => s.trim().length > 0);
      if (!/DROP\s+INDEX\s+CONCURRENTLY/i.test(sql)) continue;
      concurrent += 1;
      if (statements.length !== 1)
        offenders.push(`${name} (${statements.length} statements)`);
    }
    // The control: no file matching means the sweep is broken, not that the rule holds.
    expect(concurrent).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  // NOTE: AND THE CONVERSE: a file whose ONLY job is to drop an index drops it concurrently
  // (`.claude/rules/prisma.md`). `migrate deploy` runs on the NEW container while the OLD one serves,
  // and a plain `DROP INDEX` takes ACCESS EXCLUSIVE on the TABLE: every read and audited write queues
  // behind it. ONLY-STATEMENT keeps the rule free of exceptions: a plain drop is legitimate in two
  // shapes that both have a second statement, dropping an invalid leftover right before rebuilding it
  // (the concurrent DROP cannot share a file with `CREATE INDEX CONCURRENTLY`) and dropping a unique
  // index inside a larger schema change.
  test("a migration that only drops an index drops it concurrently", () => {
    const dir = "prisma/migrations";
    const offenders: string[] = [];
    let dropOnly = 0;
    for (const name of readdirSync(dir)) {
      const file = `${dir}/${name}/migration.sql`;
      if (!existsSync(file)) continue;
      const sql = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n")
        .replace(/\$\$[\s\S]*?\$\$/g, "$$BODY$$");
      const statements = sql.split(";").filter((s) => s.trim().length > 0);
      if (statements.length !== 1) continue;
      const only = statements[0] as string;
      if (!/^\s*DROP\s+INDEX/i.test(only)) continue;
      dropOnly += 1;
      if (!/DROP\s+INDEX\s+CONCURRENTLY/i.test(only)) offenders.push(name);
    }
    expect(dropOnly).toBeGreaterThan(0);
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

  // NOTE: The schema test reads the file; this one reads the catalog, which is what the migration
  // produced. A `DROP INDEX` left out of the migration passes the first and fails here. ONE query
  // answers both halves on purpose: asked only for offenders, it returns an empty array both for a
  // clean catalog and for a query that matches nothing (a wrong tenant column name). Listing every
  // tenant-led index and pairing here means a broken extraction empties the control too.
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
