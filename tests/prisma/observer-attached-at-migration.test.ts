import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// The attach window's column, and its backfill, which no behavioural test sees. Every
// `inbox_observers` row that predates the column was written after Chatwoot agreed, so it must
// arrive confirmed: read as pending it stalls the observe tick and reports a long-closed window. It
// arrives through the column's DEFAULT, not an UPDATE: the table is FORCE RLS, where a data
// statement by a non-superuser owner reaches zero rows and reports success, while DDL is not subject
// to RLS (tests/prisma/migration-rls-bypass.test.ts holds the rule).

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260908170002_observer_attached_at/migration.sql";

let dbUp = false;
let sql = "";
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    sql = await Bun.file(MIGRATION).text();
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;

describe.skipIf(!dbUp)("migration: the observer's attach stamp", () => {
  test("backfills through the column default, with no data statement to run under RLS", async () => {
    expect(sql).toMatch(/ADD COLUMN "attached_at"/i);
    expect(sql).toMatch(/DEFAULT CURRENT_TIMESTAMP/i);
    // No DML at all, so nothing here can silently match zero rows.
    expect(sql).not.toMatch(/^\s*UPDATE\s/im);
    expect(sql).not.toMatch(/^\s*INSERT\s/im);
    expect(sql).not.toMatch(/^\s*DELETE\s/im);
    // ...and therefore no bypass to forget, in either of its two spellings.
    expect(sql).not.toContain("app.is_super_admin");
    expect(sql).not.toMatch(/NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  test("the catalog holds a nullable column whose default is now", async () => {
    const r = await suDb.query<{
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'inbox_observers' AND column_name = 'attached_at'`,
    );
    expect(r.rows).toHaveLength(1);
    // NULLABLE, because the pending state is the whole point: `observeInbox` writes the null on
    // purpose, against this default, in the seconds between its own insert and the fork's answer.
    expect(r.rows[0]?.is_nullable).toBe("YES");
    expect(r.rows[0]?.column_default ?? "").toMatch(
      /CURRENT_TIMESTAMP|now\(\)/i,
    );
  });

  test("a row written without naming the column is confirmed, which is what the previous release writes", async () => {
    // NOTE: The rolling-deploy shape (docs/deploy.md): the previous release names no such column, so
    // its inserts must land confirmed. Raw SQL, because Prisma's client knows the column. Under the
    // fleet role from the first insert: every seeded table is FORCE RLS and the supported migration
    // account is a non-superuser owner, for which `tenants` refuses this insert. Session-level
    // (`is_local` false) because these statements are not one transaction; released in the `finally`.
    await suDb.query(
      "SELECT set_config('role', public.fazerai_fleet_role(), false)",
    );
    const tenant = await suDb.query<{ id: string }>(
      `INSERT INTO tenants (name, slug, updated_at)
       VALUES ('OBS-MIG', 'obs-mig-${process.pid}', NOW()) RETURNING id`,
    );
    const tenantId = tenant.rows[0]?.id as string;
    try {
      const dep = await suDb.query<{ id: string }>(
        `INSERT INTO chatwoot_deployments (tenant_id, base_url, admin_token, updated_at)
         VALUES ($1, 'https://obs.mig.example', 'x', NOW()) RETURNING id`,
        [tenantId],
      );
      const inst = await suDb.query<{ id: string }>(
        `INSERT INTO chatwoot_instances (tenant_id, deployment_id, account_id, server_key, updated_at)
         VALUES ($1, $2, 991, 'obs-mig-key-${process.pid}', NOW()) RETURNING id`,
        [tenantId, dep.rows[0]?.id],
      );
      const agent = await suDb.query<{ id: string }>(
        `INSERT INTO agents (tenant_id, name, system_prompt, model_config, updated_at)
         VALUES ($1, 'Observadora', 'x', '{}'::jsonb, NOW()) RETURNING id`,
        [tenantId],
      );
      const inbox = await suDb.query<{ id: string }>(
        `INSERT INTO inboxes (tenant_id, chatwoot_instance_id, chatwoot_inbox_id, name, updated_at)
         VALUES ($1, $2, 991, 'SAC', NOW()) RETURNING id`,
        [tenantId, inst.rows[0]?.id],
      );
      await suDb.query(
        `INSERT INTO inbox_observers (tenant_id, inbox_id, agent_id)
         VALUES ($1, $2, $3)`,
        [tenantId, inbox.rows[0]?.id, agent.rows[0]?.id],
      );
      const row = await suDb.query<{ attached_at: Date | null }>(
        `SELECT attached_at FROM inbox_observers WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]?.attached_at).not.toBeNull();
    } finally {
      for (const t of [
        "inbox_observers",
        "inboxes",
        "agents",
        "chatwoot_instances",
        "chatwoot_deployments",
      ]) {
        await suDb
          .query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId])
          .catch(() => {});
      }
      await suDb.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
      await suDb.query("RESET ROLE");
    }
  });
});
