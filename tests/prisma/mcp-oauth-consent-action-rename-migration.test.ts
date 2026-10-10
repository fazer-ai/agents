import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Runs the actual migration file: the two consent actions that predate the `<entity>.<verb>`
// convention are rewritten on rows on BOTH sides of the tenant boundary, and nothing else moves. The
// tenant-null half matters: `audit_logs` is FORCE RLS and `MIGRATION_DATABASE_URL` may be an owner
// without rolsuper, for which a cross-tenant UPDATE matches zero rows and reports success
// (tests/prisma/migration-rls-bypass.test.ts asks for the bypass; this asserts its effect per row).
// `created_at` and `id` must not change: the trail is paged by that pair.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260908120000_rename_mcp_oauth_consent_actions/migration.sql";

// Read outside the connection guard: folding a missing migration file into the `catch` that answers
// "no database here" would turn it into a silent skip.
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

// Runs the file one statement at a time, on one connection, as `migrate deploy` does: a file is not
// atomic unless it opens its own BEGIN. Handing the whole text to `pg` would prove nothing, since a
// multi-statement string goes over the simple-query protocol, which Postgres wraps in an implicit
// transaction. Why `migrate deploy` behaves this way is deliberately not claimed: see
// `.claude/rules/prisma.md`, "O arquivo da migration NÃO roda em transação".
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

  // NOTE: And it is back even when the file fails halfway, which is what the BEGIN buys: Prisma runs
  // the `.sql` outside a transaction, so without one a failure after the lift leaves `audit_logs`
  // with FORCE off and the migration marked applied. The file is made to fail on purpose.
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
