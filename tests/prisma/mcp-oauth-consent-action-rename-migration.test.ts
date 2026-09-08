import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Runs the ACTUAL migration file against the test database. What it pins: the two consent actions
// that predate the `<entity>.<verb>` convention are rewritten on the rows already recorded under
// them, on BOTH sides of the tenant boundary, and nothing else about those rows moves.
//
// THE TENANT-NULL HALF IS THE POINT, not a completeness flourish. `audit_logs` carries FORCE ROW
// LEVEL SECURITY, which binds the table owner too, and `MIGRATION_DATABASE_URL` is only promised to
// be "superuser OR owner" — on managed Postgres, typically owner without rolsuper, where an UPDATE
// across tenants matches ZERO rows and reports success. `tests/prisma/migration-rls-bypass.test.ts`
// asks that of every data migration; what this file adds is the effect, per row.
//
// `created_at` and `id` are asserted UNCHANGED because the trail is paged by exactly that pair
// (#530, #537): a backfill that touched either would reorder rows an operator is walking, and no
// assertion about the action name would notice.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260908120000_rename_mcp_oauth_consent_actions/migration.sql";

// READ OUTSIDE THE CONNECTION GUARD. A missing migration file is this test's subject failing to
// exist, and folding it into the same `catch` that answers "no database here" would turn that into
// a silent skip — the shard reports 0 fail and the backfill was never written.
const sql = await Bun.file(MIGRATION).text();

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
const suDb = su as Client;

let tenantId = 0n;
const ids: Record<string, bigint> = {};

async function row(
  key: string,
  action: string,
  tenant: bigint | null,
): Promise<void> {
  const r = await suDb.query(
    `INSERT INTO "audit_logs" (tenant_id, actor_id, actor_type, action, target, "after", created_at)
     VALUES ($1, NULL, 'user', $2, $3, $4::jsonb, NOW()) RETURNING id`,
    [
      tenant === null ? null : String(tenant),
      action,
      `client:${key}`,
      JSON.stringify({ scopes: ["mcp:read"] }),
    ],
  );
  ids[key] = BigInt(r.rows[0].id);
}

async function stateOf(key: string) {
  const r = await suDb.query(
    'SELECT action, target, "after", created_at, tenant_id FROM "audit_logs" WHERE id = $1',
    [String(ids[key])],
  );
  return r.rows[0];
}

async function forced(): Promise<boolean> {
  const r = await suDb.query<{ f: boolean }>(
    "SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'audit_logs' AND relkind = 'r'",
  );
  return r.rows[0]?.f === true;
}

// RUNS THE FILE THE WAY `migrate deploy` RUNS IT: one statement at a time, on one connection.
//
// Handing the whole file to `pg` instead would prove nothing about atomicity. A multi-statement
// string goes out over the simple-query protocol, which Postgres wraps in an IMPLICIT transaction,
// so the file is atomic whatever it says — measured, with the file's own BEGIN deleted every
// assertion here still passed. Prisma splits, which is why the file needs a BEGIN of its own.
//
// Measured directly (a scratch database, `migrate deploy`, a file that fails after its first
// statement): without BEGIN the first statement PERSISTS through the failure; with it, the state is
// back. That is the measurement `.claude/rules/prisma.md` records.
function statementsOf(text: string): string[] {
  const bare = text.replace(/^\s*--.*$/gm, "");
  // Dollar quoting is the one thing this scanner cannot see through, so it refuses the file rather
  // than cutting a function body in half and running the halves.
  if (bare.includes("$$")) {
    throw new Error(
      "statementsOf: dollar quoting needs a real parser, not this scanner",
    );
  }
  const out: string[] = [];
  let current = "";
  let inLiteral = false;
  for (const ch of bare) {
    // An escaped quote inside a literal is doubled, which toggles twice and lands back inside it.
    if (ch === "'") inLiteral = !inLiteral;
    if (ch === ";" && !inLiteral) {
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
  return out;
}

async function runMigration(text: string): Promise<void> {
  try {
    for (const statement of statementsOf(text)) await suDb.query(statement);
  } catch (e) {
    // The engine drops the connection when a migration fails, which rolls back whatever transaction
    // the file had open. Ending it here is that teardown, on a client the rest of the suite shares.
    await suDb.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

describe.skipIf(!dbUp)("migration: rename the MCP consent actions", () => {
  let before: Record<string, Awaited<ReturnType<typeof stateOf>>> = {};

  beforeAll(async () => {
    const t = await suDb.query(
      `INSERT INTO tenants (name, slug, updated_at)
       VALUES ('CONSENTRENAME', $1, NOW()) RETURNING id`,
      [`consentrename-${process.pid}`],
    );
    tenantId = BigInt(t.rows[0].id);
    // The four rows the rename has an opinion about, and two it must not touch.
    await row("granted-tenant", "mcp_oauth_consent_granted", tenantId);
    await row("denied-tenant", "mcp_oauth_consent_denied", tenantId);
    await row("granted-fleet", "mcp_oauth_consent_granted", null);
    await row("denied-fleet", "mcp_oauth_consent_denied", null);
    // A neighbour in the same family, already conventional: the UPDATE must be keyed on the whole
    // name, not on the `mcp_` prefix.
    await row("neighbour", "mcp_client.create", null);
    // A row already carrying the target name, as a database first installed after this release
    // would have. Re-running must leave it exactly where it is.
    await row("already-new", "mcp_oauth_consent.grant", tenantId);
    before = Object.fromEntries(
      await Promise.all(
        Object.keys(ids).map(async (k) => [k, await stateOf(k)] as const),
      ),
    );
    await runMigration(sql);
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
      String(tenantId),
    ]);
    await suDb.query(
      `DELETE FROM audit_logs WHERE tenant_id IS NULL AND target IN ($1, $2, $3)`,
      [`client:granted-fleet`, `client:denied-fleet`, `client:neighbour`],
    );
    await suDb.query("DELETE FROM tenants WHERE id = $1", [String(tenantId)]);
    await suDb.end();
  });

  test("both names are rewritten, on a tenant's trail and on the fleet's", async () => {
    expect([
      (await stateOf("granted-tenant")).action,
      (await stateOf("denied-tenant")).action,
      (await stateOf("granted-fleet")).action,
      (await stateOf("denied-fleet")).action,
    ]).toEqual([
      "mcp_oauth_consent.grant",
      "mcp_oauth_consent.deny",
      "mcp_oauth_consent.grant",
      "mcp_oauth_consent.deny",
    ]);
  });

  test("no row is left under either old name", async () => {
    const r = await suDb.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs
        WHERE action IN ('mcp_oauth_consent_granted', 'mcp_oauth_consent_denied')`,
    );
    expect(r.rows[0]?.n).toBe("0");
  });

  test("nothing but the action moves, including the pair the trail is paged by", async () => {
    for (const key of Object.keys(ids)) {
      const now = await stateOf(key);
      expect([
        key,
        now.target,
        now.after,
        now.created_at,
        now.tenant_id,
      ]).toEqual([
        key,
        before[key].target,
        before[key].after,
        before[key].created_at,
        before[key].tenant_id,
      ]);
    }
  });

  test("a neighbour in the same family is untouched", async () => {
    expect((await stateOf("neighbour")).action).toBe("mcp_client.create");
  });

  // THE REPAIR THE DEPLOY NOTE PROMISES. An image that predates #552 still RECORDS the underscored
  // names, so on a direct upgrade or after a rollback a consent decision can land under one AFTER
  // this one-shot migration scanned past it, and the new catalog no longer offers that spelling.
  // `docs/deploy.md` says the remedy is re-running these two UPDATEs; this is that claim, and it is
  // asserted rather than promised (round 2 of review).
  test("a re-run moves a legacy row that landed after it", async () => {
    await row("straggler", "mcp_oauth_consent_denied", tenantId);
    await runMigration(sql);
    expect((await stateOf("straggler")).action).toBe("mcp_oauth_consent.deny");
  });

  test("a re-run rewrites nothing", async () => {
    await runMigration(sql);
    expect([
      (await stateOf("already-new")).action,
      (await stateOf("granted-tenant")).action,
      (await stateOf("neighbour")).action,
    ]).toEqual([
      "mcp_oauth_consent.grant",
      "mcp_oauth_consent.grant",
      "mcp_client.create",
    ]);
  });

  test("FORCE ROW LEVEL SECURITY is back on the table it lifted it from", async () => {
    expect(await forced()).toBe(true);
  });

  // AND IT IS BACK EVEN WHEN THE FILE FAILS HALFWAY, which is what the BEGIN buys. Prisma runs the
  // `.sql` OUTSIDE a transaction (measured in #520, in both modes), so without one a failure after
  // the lift leaves `audit_logs` with FORCE off: the table stops binding its owner to the tenant
  // policy, and the migration is marked applied. Asserted by making the file fail on purpose rather
  // than by trusting the BEGIN is there (round 3 of review).
  test("a failure after the lift restores FORCE instead of leaving it off", async () => {
    const broken = sql.replace(
      'ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;',
      'SELECT 1 / 0;\nALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;',
    );
    expect(broken).not.toBe(sql);
    await expect(runMigration(broken)).rejects.toThrow();
    expect(await forced()).toBe(true);
  });
});
