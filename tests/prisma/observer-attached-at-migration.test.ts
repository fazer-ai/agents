import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// THE ATTACH WINDOW'S OWN COLUMN (issue #540, window 5), and what is under test here is the
// BACKFILL — the half a behavioural test cannot see, because every fixture it runs against was
// written by this build.
//
// `inbox_observers` used to be written only once Chatwoot had agreed, so every row that exists on an
// install today is a confirmed one. Read as pending, each of them would stop the observe tick (it
// retries rather than acting on a binding that has not landed) and make the receiver report an
// attach window that closed months ago. So the column has to arrive already true for them.
//
// It arrives that way through the column's DEFAULT rather than through an UPDATE, and that is the
// decision under test as much as the value is: `inbox_observers` carries FORCE ROW LEVEL SECURITY,
// and a data statement run by an owner who is not a superuser reaches ZERO rows and reports success
// (docs/deploy.md; tests/prisma/migration-rls-bypass.test.ts is where the rule itself lives). DDL is
// not subject to RLS, so `ADD COLUMN ... DEFAULT` fills the existing rows with no bypass to forget.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260907090002_observer_attached_at/migration.sql";

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
    // The rolling-deploy shape (docs/deploy.md): the release before this one names no such column,
    // so its inserts must land confirmed. Written through the catalog rather than through Prisma,
    // because Prisma's client knows the column and the point is a writer that does not.
    // UNDER THE FLEET ROLE, from the FIRST insert (PR review, round 8). Every table this seeds
    // carries FORCE ROW LEVEL SECURITY, and the supported migration account is an owner that is not
    // a superuser (docs/deploy.md): for it, `tenants` refuses this insert outright, and the GUC that
    // used to lift RLS has been inert since the policy split — the fence in
    // `tests/prisma/migration-rls-bypass.test.ts` is where that history is written down. Left as it
    // was, this test passed only where the migration account happened to be a real superuser, which
    // is the one configuration the rule exists to stop anybody relying on.
    //
    // Session-level (`is_local` false), because these statements are not one transaction, and
    // released in the `finally` below.
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
