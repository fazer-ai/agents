import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";

// The (tenant_id, dedupe_key) index is the one some instances already run, created by hand under this
// exact name, and it is what keeps their follow-up sweep under its budget. The two files that build it
// must leave a valid copy alone (dropping it would leave the old container, still serving during a
// rolling deploy, without the index for the whole rebuild), build it where it is missing, and rebuild
// only an invalid leftover of an interrupted concurrent build. Run against a probe table with the
// names swapped, one file per statement batch as the runner sends them, so the real index of a
// database other files share is never touched.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const DROP_INVALID =
  "prisma/migrations/20261105000000_scheduler_jobs_drop_invalid_dedupe_key_index/migration.sql";
const BUILD =
  "prisma/migrations/20261105000050_scheduler_jobs_tenant_dedupe_key_index/migration.sql";
const TABLE = "scheduler_jobs";
const INDEX = "scheduler_jobs_tenant_id_dedupe_key_idx";
const PROBE_TABLE = `sched_dedupe_probe_${process.pid}`;
const PROBE_INDEX = `sched_dedupe_probe_${process.pid}_idx`;

let dbUp = false;
let su: Client | undefined;
let files: string[] = [];
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    files = [await Bun.file(DROP_INVALID).text(), await Bun.file(BUILD).text()];
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as Client;

// The index name first: the table's is a prefix of it.
function onProbe(sql: string): string {
  return sql.replaceAll(INDEX, PROBE_INDEX).replaceAll(TABLE, PROBE_TABLE);
}

async function migrate(): Promise<void> {
  for (const sql of files) await suDb.query(onProbe(sql));
}

async function probeIndex(): Promise<{ oid: number; valid: boolean } | null> {
  const r = await suDb.query<{ oid: number; valid: boolean }>(
    `SELECT c.oid::int AS oid, i.indisvalid AS valid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [PROBE_INDEX],
  );
  return r.rows[0] ?? null;
}

describe.skipIf(!dbUp)(
  "migration: the (tenant_id, dedupe_key) index on scheduler_jobs",
  () => {
    beforeAll(async () => {
      await suDb.query(
        `CREATE TABLE "${PROBE_TABLE}" (tenant_id bigint, dedupe_key text)`,
      );
    });

    afterAll(async () => {
      await suDb.query(`DROP TABLE IF EXISTS "${PROBE_TABLE}"`);
      await suDb.end();
    });

    test("builds the index where it is missing", async () => {
      await suDb.query(`DROP INDEX IF EXISTS "${PROBE_INDEX}"`);
      await migrate();
      expect((await probeIndex())?.valid).toBe(true);
    });

    test("leaves a valid index with this name alone", async () => {
      await suDb.query(`DROP INDEX IF EXISTS "${PROBE_INDEX}"`);
      await suDb.query(
        `CREATE INDEX "${PROBE_INDEX}" ON "${PROBE_TABLE}" (tenant_id, dedupe_key)`,
      );
      const before = await probeIndex();
      await migrate();
      expect(await probeIndex()).toEqual({
        oid: before?.oid as number,
        valid: true,
      });
    });

    test("rebuilds an invalid leftover of an interrupted build", async () => {
      await suDb.query(`DROP INDEX IF EXISTS "${PROBE_INDEX}"`);
      await suDb.query(
        `CREATE INDEX "${PROBE_INDEX}" ON "${PROBE_TABLE}" (tenant_id, dedupe_key)`,
      );
      // `indisvalid = false` is all an interrupted concurrent build leaves for the planner to read.
      await suDb.query(
        `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"${PROBE_INDEX}"'::regclass`,
      );
      const before = await probeIndex();
      expect(before?.valid).toBe(false);
      await migrate();
      const after = await probeIndex();
      expect(after?.valid).toBe(true);
      expect(after?.oid).not.toBe(before?.oid);
    });
  },
);
