import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { FLEET_ROLE_FN } from "@/lib/tenancy/fleet-role";

// The tenant-policy split migration is driven off the CATALOG rather than a list of tables, since a
// list goes stale. The cost is one failure mode: a loop over a catalog that does not look the way it
// assumed completes silently, leaving half a schema split. So the migration ends in its own count
// assertion, and this file proves that assertion fires, on a MINIMAL database because the state it
// guards against cannot exist in the suite's. Delete the block and only the second test turns red.

const MIGRATION =
  "prisma/migrations/20260827000000_rls_split_tenant_and_fleet_policies/migration.sql";

const suUrl = process.env.MIGRATION_DATABASE_URL;
const PROBE_DB = `fazerai_rlssplit_${process.pid}`;
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

// The two tables the migration names outright, plus whatever the caller wants beside them.
const BASE_SCHEMA = `
  CREATE TABLE tenants (id bigserial PRIMARY KEY, name text NOT NULL);
  CREATE TABLE audit_logs (id bigserial PRIMARY KEY, tenant_id bigint);
  CREATE TABLE things (id bigserial PRIMARY KEY, tenant_id bigint NOT NULL);
`;

const OLD_POLICY = (table: string, column: string) => `
  ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON ${table}
    USING (current_setting('app.is_super_admin', true) = 'on'
           OR ${column} = nullif(current_setting('app.tenant_id', true), '')::bigint)
    WITH CHECK (current_setting('app.is_super_admin', true) = 'on'
           OR ${column} = nullif(current_setting('app.tenant_id', true), '')::bigint);
`;

async function onProbe<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: probeUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// Applies the migration verbatim to a probe database seeded with `extra`, and reports the error if
// it refuses. The migration is read from disk, never retyped: a copy here would go on passing after
// the file it stands for changed.
async function applyMigration(extra: string): Promise<string | null> {
  const suDb = su as Client;
  await suDb.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
  await suDb.query(`CREATE DATABASE ${PROBE_DB}`);
  const sql = await Bun.file(MIGRATION).text();
  return onProbe(async (c) => {
    await c.query(BASE_SCHEMA);
    await c.query(OLD_POLICY("tenants", "id"));
    await c.query(OLD_POLICY("audit_logs", "tenant_id"));
    await c.query(extra);
    try {
      await c.query(sql);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  });
}

describe.skipIf(!dbUp)("the RLS policy split migration", () => {
  afterAll(async () => {
    if (su) {
      await su.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
      // NOTE: The role the migration created here, whose NAME carries the probe database. Dropping a
      // database does not drop a role, so without this every run leaves one behind (the same accumulation
      // `migrate dev` causes with its shadow database).
      for (const { rolname } of (
        await su.query<{ rolname: string }>(
          "SELECT rolname FROM pg_roles WHERE rolname LIKE $1",
          [`fazerai_fleet_%${process.pid}%`],
        )
      ).rows) {
        await su.query(`DROP ROLE IF EXISTS "${rolname}"`);
      }
      await su.end();
    }
  });

  test("splits every table it finds, without being told which they are", async () => {
    const failure = await applyMigration(OLD_POLICY("things", "tenant_id"));
    expect(failure).toBeNull();

    // The role the probe database resolves to, asked of the probe database — its name carries the
    // database, so it is NOT the one this suite's own database uses.
    const fleetRole = await onProbe(
      async (c) =>
        (await c.query<{ role: string }>(`SELECT ${FLEET_ROLE_FN} AS role`))
          .rows[0]?.role as string,
    );
    expect(fleetRole).toContain(PROBE_DB.slice(0, 30));

    const policies = await onProbe(
      async (c) =>
        (
          await c.query<{
            table_name: string;
            policy: string;
            qual: string;
            roles: string[];
          }>(`
        SELECT c.relname AS table_name, p.polname AS policy,
               pg_get_expr(p.polqual, p.polrelid) AS qual,
               COALESCE(
                 (SELECT array_agg(r.rolname::text ORDER BY r.rolname)
                    FROM pg_roles r WHERE r.oid = ANY (p.polroles)),
                 ARRAY['public']::text[]) AS roles
          FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
         ORDER BY 1, 2`)
        ).rows,
    );

    // `things` was never named anywhere in the migration — the catalog is how it was found.
    expect(policies.map((p) => `${p.table_name}.${p.policy}`)).toEqual([
      "audit_logs.fleet_super_admin",
      "audit_logs.tenant_isolation",
      "tenants.fleet_super_admin",
      "tenants.tenant_isolation",
      "things.fleet_super_admin",
      "things.tenant_isolation",
    ]);
    for (const p of policies) {
      if (p.policy === "tenant_isolation") {
        expect(p.qual).not.toContain("is_super_admin");
        expect(p.roles).toEqual(["public"]);
      } else {
        expect(p.roles).toEqual([fleetRole]);
      }
    }
    // `tenants` is keyed by its own id, and the split has to preserve that rather than assume a
    // `tenant_id` column everywhere.
    const tenantsPolicy = policies.find(
      (p) => p.table_name === "tenants" && p.policy === "tenant_isolation",
    );
    // The COLUMN, not the substring: `app.tenant_id` is the GUC's name and appears in every qual.
    expect(tenantsPolicy?.qual).toContain("(id =");
    expect(tenantsPolicy?.qual).not.toContain("(tenant_id =");
    const thingsPolicy = policies.find(
      (p) => p.table_name === "things" && p.policy === "tenant_isolation",
    );
    expect(thingsPolicy?.qual).toContain("(tenant_id =");
  });

  // The shape that COUNTING misses, which is why the assertion is per table. Here the totals balance
  // exactly — one RLS table whose policy has another name, and one NON-RLS table carrying a
  // `tenant_isolation` that the loop skips and the count would happily include — so a check written
  // as `n_tenant = n_rls` commits with a real table left unsplit.
  test("refuses a drift whose totals happen to balance", async () => {
    const failure = await applyMigration(`
      ${OLD_POLICY("things", "tenant_id")}
      CREATE TABLE strays (id bigserial PRIMARY KEY, tenant_id bigint NOT NULL);
      ALTER TABLE strays ENABLE ROW LEVEL SECURITY;
      CREATE POLICY some_other_name ON strays USING (true);
      CREATE TABLE bystander (id bigserial PRIMARY KEY, tenant_id bigint NOT NULL);
      CREATE POLICY tenant_isolation ON bystander USING (true);
    `);
    expect(failure).toContain("RLS policy split did not land");
    expect(failure).toContain("strays");
    // And it does NOT blame the table that is merely carrying a same-named policy without RLS.
    expect(failure).not.toContain("bystander");
  });
});
