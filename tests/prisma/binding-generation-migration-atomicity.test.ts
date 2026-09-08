import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// The migration adds ONE fact in two statements: the inbox counts who routes it, and the delivery
// records the count it arrived under. Half of that pair is not half a feature, it is a rollout that
// cannot continue — `migrate deploy` runs the file OUTSIDE a transaction, so a failure on the second
// `ALTER TABLE` leaves the first committed, and the retry meets `duplicate_column` and stops until
// somebody edits schema by hand. The file's own `BEGIN`/`COMMIT` is what prevents that.
//
// ASKED STATEMENT BY STATEMENT, because that is the only way to ask it. A multi-statement string
// goes out over the simple-query protocol and Postgres wraps it in an IMPLICIT transaction, so the
// file comes out atomic whatever it says and deleting the `BEGIN` breaks nothing
// (.claude/rules/prisma.md, measured in #555). Prisma sends them one at a time; so does this.
//
// ON A PROBE DATABASE with two bare tables, not on the suite's: the columns already exist there, and
// dropping them to make room would take the triggers of 20260908170003 down with them.

const MIGRATION =
  "prisma/migrations/20260908170000_binding_generation/migration.sql";

const suUrl = process.env.MIGRATION_DATABASE_URL;
const PROBE_DB = `fazerai_bindgen_${process.pid}`;
let dbUp = false;
let su: Client | undefined;

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

function probeUrl(): string {
  const u = new URL(suUrl as string);
  u.pathname = `/${PROBE_DB}`;
  return u.toString();
}

const BASE_SCHEMA = `
  CREATE TABLE inboxes (id bigserial PRIMARY KEY);
  CREATE TABLE chatwoot_webhook_deliveries (id bigserial PRIMARY KEY);
`;

// Comment lines out, then cut on semicolons. The file carries no dollar quoting and no literals, and
// the assertions below say so rather than trusting it: a file that grows either needs a real parser.
function statementsOf(text: string): string[] {
  const bare = text.replace(/^\s*--.*$/gm, "");
  expect(bare).not.toContain("$$");
  expect(bare).not.toContain("'");
  const out = bare
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  expect(out.length).toBeGreaterThan(1);
  return out.map((s) => `${s};`);
}

// Runs the file the way Prisma does — one statement per round trip — on a database freshly seeded
// with the two tables, and reports the failure if one comes. The probe connection is closed before
// returning: the next run drops the database `WITH (FORCE)`, which would otherwise cut the previous
// run's socket and surface as "Connection terminated" from an unrelated test.
async function applyStatementByStatement(sql: string): Promise<{
  failed: string | null;
  columns: Record<string, boolean>;
}> {
  const suDb = su as Client;
  await suDb.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
  await suDb.query(`CREATE DATABASE ${PROBE_DB}`);
  const c = new Client({ connectionString: probeUrl() });
  await c.connect();
  try {
    await c.query(BASE_SCHEMA);
    let failed: string | null = null;
    try {
      for (const statement of statementsOf(sql)) await c.query(statement);
    } catch (e) {
      failed = (e as Error).message;
      // The failure leaves the file's transaction open on this connection; the rollout's own client
      // dies here, and closing the block is how this one stands in for that.
      await c.query("ROLLBACK").catch(() => {});
    }
    const columns: Record<string, boolean> = {};
    for (const table of ["inboxes", "chatwoot_webhook_deliveries"]) {
      columns[table] =
        (
          await c.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
            [table, "binding_generation"],
          )
        ).rowCount === 1;
    }
    return { failed, columns };
  } finally {
    await c.end();
  }
}

describe.skipIf(!dbUp)("the binding generation migration", () => {
  afterAll(async () => {
    if (su) {
      await su.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
      await su.end();
    }
  });

  test("adds the counter and the delivery's record of it", async () => {
    const sql = await Bun.file(MIGRATION).text();
    const { failed, columns } = await applyStatementByStatement(sql);
    expect(failed).toBeNull();
    expect(columns.inboxes).toBe(true);
    expect(columns.chatwoot_webhook_deliveries).toBe(true);
  });

  // The reason the file opens a transaction, asserted by making it fail on purpose rather than by
  // reading the `BEGIN` and believing it. Remove the `BEGIN`/`COMMIT` and this goes red: the inbox
  // keeps a column the retry cannot add again.
  test("a failure before the second column leaves neither, not one", async () => {
    const sql = await Bun.file(MIGRATION).text();
    const broken = sql.replace(
      'ALTER TABLE "chatwoot_webhook_deliveries"',
      'SELECT 1 / 0;\nALTER TABLE "chatwoot_webhook_deliveries"',
    );
    expect(broken).not.toBe(sql);
    const { failed, columns } = await applyStatementByStatement(broken);
    expect(failed).toContain("division by zero");
    expect(columns.inboxes).toBe(false);
    expect(columns.chatwoot_webhook_deliveries).toBe(false);
  });
});
