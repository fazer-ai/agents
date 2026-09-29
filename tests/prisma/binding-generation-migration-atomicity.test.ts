import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Two migrations leave an invariant half-applied if they stop in the middle, and `migrate deploy`
// runs a migration OUTSIDE a transaction, so each opens its own. Half of COLUMNS_MIGRATION makes the
// retry meet `duplicate_column`; half of TRIGGERS_MIGRATION counts responder moves and misses
// observer moves, a counter that LIES to every reader that trusts it to mean "nothing moved".
// Asked statement by statement, as Prisma sends them: a multi-statement string gets an IMPLICIT
// transaction and would pass without the `BEGIN` (.claude/rules/prisma.md). On a PROBE database
// seeded with the bare tables: the suite's already has the columns and triggers.

const COLUMNS_MIGRATION =
  "prisma/migrations/20260908170000_binding_generation/migration.sql";
const TRIGGERS_MIGRATION =
  "prisma/migrations/20260908170003_binding_generation_triggers/migration.sql";

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

// Only what the two files actually name. The trigger file's `WHEN` clauses and its `UPDATE OF` are
// checked against the catalog at creation time, so those columns have to be here; the function
// bodies are not, and the rest of each table is not either.
const BASE_SCHEMA = `
  CREATE TABLE inboxes (
    id bigserial PRIMARY KEY,
    agent_id bigint
  );
  CREATE TABLE chatwoot_webhook_deliveries (id bigserial PRIMARY KEY);
  CREATE TABLE inbox_observers (
    id bigserial PRIMARY KEY,
    inbox_id bigint NOT NULL,
    agent_id bigint NOT NULL
  );
`;

// Comment lines out, then cut on semicolons, outside a literal and outside a `$$` body, since the
// trigger file's functions carry semicolons of their own.
function statementsOf(text: string): string[] {
  const bare = text.replace(/^\s*--.*$/gm, "");
  const out: string[] = [];
  let current = "";
  let inLiteral = false;
  let inDollar = false;
  for (let i = 0; i < bare.length; i++) {
    const ch = bare[i] as string;
    if (!inLiteral && ch === "$" && bare[i + 1] === "$") {
      inDollar = !inDollar;
      current += "$$";
      i++;
      continue;
    }
    // An escaped quote inside a literal is doubled, which toggles twice and lands back inside it.
    if (!inDollar && ch === "'") inLiteral = !inLiteral;
    if (ch === ";" && !inLiteral && !inDollar) {
      if (current.trim()) out.push(`${current.trim()};`);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    throw new Error(
      "statementsOf: the file does not end on a statement terminator",
    );
  }
  expect(out.length).toBeGreaterThan(1);
  return out;
}

type Probe = { failed: string | null; columns: string[]; triggers: string[] };

// Runs the file the way Prisma does (one statement per round trip) on a freshly seeded database,
// and reports the failure if one comes. The probe connection is closed before returning: the next
// run drops the database `WITH (FORCE)`, which would otherwise cut this run's socket and surface as
// "Connection terminated" from an unrelated test.
async function applyStatementByStatement(sql: string): Promise<Probe> {
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
    const columns = (
      await c.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.columns WHERE column_name = 'binding_generation' ORDER BY table_name",
      )
    ).rows.map((r) => r.table_name);
    const triggers = (
      await c.query<{ tgname: string }>(
        "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname",
      )
    ).rows.map((r) => r.tgname);
    return { failed, columns, triggers };
  } finally {
    await c.end();
  }
}

async function withColumns(): Promise<string> {
  const columns = await Bun.file(COLUMNS_MIGRATION).text();
  const triggers = await Bun.file(TRIGGERS_MIGRATION).text();
  return `${columns}\n${triggers}`;
}

describe.skipIf(!dbUp)("the binding generation migrations", () => {
  afterAll(async () => {
    if (su) {
      await su.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
      await su.end();
    }
  });

  test("adds the counter, the delivery's record of it, and the triggers that step it", async () => {
    const { failed, columns, triggers } = await applyStatementByStatement(
      await withColumns(),
    );
    expect(failed).toBeNull();
    expect(columns).toEqual(["chatwoot_webhook_deliveries", "inboxes"]);
    expect(triggers).toEqual([
      "inbox_observers_bump_binding_generation",
      "inbox_observers_bump_binding_generation_on_move",
      "inboxes_bump_binding_generation",
    ]);
  });

  // The reason each file opens a transaction, asserted by making it fail on purpose rather than by
  // reading the `BEGIN` and believing it.

  test("a failure before the second column leaves neither, not one", async () => {
    const sql = await Bun.file(COLUMNS_MIGRATION).text();
    const broken = sql.replace(
      'ALTER TABLE "chatwoot_webhook_deliveries"',
      'SELECT 1 / 0;\nALTER TABLE "chatwoot_webhook_deliveries"',
    );
    expect(broken).not.toBe(sql);
    const { failed, columns } = await applyStatementByStatement(broken);
    expect(failed).toContain("division by zero");
    expect(columns).toEqual([]);
  });

  // Half the triggers is the case `CREATE OR REPLACE` does NOT answer: replacing makes the RETRY
  // idempotent, and says nothing about the window in which the responder side counts and the
  // observer side does not.
  test("a failure before the observer triggers leaves no trigger at all", async () => {
    const sql = await Bun.file(TRIGGERS_MIGRATION).text();
    const broken = sql.replace(
      "CREATE OR REPLACE FUNCTION bump_binding_generation_on_observer()",
      "SELECT 1 / 0;\nCREATE OR REPLACE FUNCTION bump_binding_generation_on_observer()",
    );
    expect(broken).not.toBe(sql);
    const { failed, triggers } = await applyStatementByStatement(
      `${await Bun.file(COLUMNS_MIGRATION).text()}\n${broken}`,
    );
    expect(failed).toContain("division by zero");
    expect(triggers).toEqual([]);
  });
});
