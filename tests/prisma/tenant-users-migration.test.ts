import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Issue #756: `users` stops being one row per (person, tenant) and becomes one row per PERSON, with
// the tenants in `tenant_users`. The migration that does it MERGES rows: every email that existed in
// several tenants becomes one person, and the row that stays is the one that logged in last (the
// owner's decision on the issue: its password is the one the person used most recently).
//
// ON A PROBE DATABASE seeded with the OLD shape, because the suite's database already has the new
// one. Only what the file names is created, with the constraint and index names the baseline gave
// them, since the file drops them by name. RUN STATEMENT BY STATEMENT, as Prisma runs it: a
// multi-statement string would be wrapped in an implicit transaction and prove nothing about the
// file's own (.claude/rules/prisma.md, #555). AS THE TABLES' OWNER, not as a superuser: a superuser
// passes every row-level policy, FORCE or not, and the owner the deploy runs as does not, so a write
// to a FORCE-RLS table that forgot to lift it would decide over zero rows here too.

const MIGRATION = "prisma/migrations/20260925000000_tenant_users/migration.sql";
const sql = await Bun.file(MIGRATION).text();

const suUrl = process.env.MIGRATION_DATABASE_URL;
const PROBE_DB = `fazerai_tenant_users_${process.pid}`;
const PROBE_OWNER = `fazerai_tenant_users_owner_${process.pid}`;
let dbUp = false;
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    await su.query(`DROP ROLE IF EXISTS ${PROBE_OWNER}`);
    await su.query(`CREATE ROLE ${PROBE_OWNER} NOLOGIN`);
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

const OLD_SHAPE = `
  CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'TENANT_ADMIN', 'AGENT');
  CREATE TABLE tenants (id bigserial PRIMARY KEY, name text NOT NULL);
  CREATE TABLE users (
    id bigserial NOT NULL,
    tenant_id bigint,
    email text NOT NULL,
    password_hash text,
    google_id text,
    name text,
    role "UserRole" NOT NULL DEFAULT 'AGENT',
    last_login_at timestamp(3),
    created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_pkey PRIMARY KEY (id)
  );
  CREATE UNIQUE INDEX users_google_id_key ON users (google_id);
  ALTER TABLE users ADD CONSTRAINT users_auth_method_check
    CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL);
  CREATE INDEX users_tenant_id_idx ON users (tenant_id);
  ALTER TABLE users ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE CASCADE;
  CREATE UNIQUE INDEX users_tenant_email_key ON users (tenant_id, lower(email)) WHERE tenant_id IS NOT NULL;
  CREATE UNIQUE INDEX users_superadmin_email_key ON users (lower(email)) WHERE tenant_id IS NULL;
  ALTER TABLE users ADD CONSTRAINT users_role_tenant_check CHECK (
    (role = 'SUPER_ADMIN' AND tenant_id IS NULL) OR (role <> 'SUPER_ADMIN' AND tenant_id IS NOT NULL)
  );
  CREATE TABLE invitations (id bigserial PRIMARY KEY, tenant_id bigint, invited_by_id bigint);
  CREATE TABLE mcp_oauth_authorization_codes (id bigserial PRIMARY KEY, user_id bigint NOT NULL);
  CREATE TABLE mcp_oauth_access_tokens (id bigserial PRIMARY KEY, user_id bigint NOT NULL);
  CREATE TABLE mcp_oauth_refresh_tokens (id bigserial PRIMARY KEY, user_id bigint NOT NULL);
  CREATE TABLE mcp_oauth_pending_authorizations (id bigserial PRIMARY KEY, user_id bigint NOT NULL);
  CREATE TABLE mcp_oauth_client_approvals (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL, client_id text NOT NULL,
    UNIQUE (user_id, client_id)
  );
  CREATE TABLE api_keys (id bigserial PRIMARY KEY, tenant_id bigint, created_by_user_id bigint);
  CREATE TABLE audit_logs (
    id bigserial PRIMARY KEY, tenant_id bigint, actor_id bigint,
    actor_type text NOT NULL DEFAULT 'user', action text NOT NULL, target text,
    "before" jsonb, "after" jsonb, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

// The two FORCE-RLS tables the file writes to, locked down the way the baseline does, after the seed.
const LOCK_DOWN = ["api_keys", "audit_logs"]
  .map(
    (t) => `
  ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON ${t}
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::bigint);`,
  )
  .join("\n");

// Comment lines out, then cut on semicolons outside a literal and outside a `$$` body.
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
    if (!inDollar && ch === "'") inLiteral = !inLiteral;
    if (ch === ";" && !inLiteral && !inDollar) {
      if (current.trim()) out.push(`${current.trim()};`);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    throw new Error("statementsOf: the file does not end on a terminator");
  }
  return out;
}

type Ids = Record<string, string>;

async function seed(c: Client): Promise<Ids> {
  const ids: Ids = {};
  const one = async (key: string, q: string, params: unknown[]) => {
    const r = await c.query<{ id: string }>(`${q} RETURNING id`, params);
    ids[key] = String(r.rows[0]?.id);
  };
  await one("A", "INSERT INTO tenants (name) VALUES ('A')", []);
  await one("B", "INSERT INTO tenants (name) VALUES ('B')", []);
  await one("C", "INSERT INTO tenants (name) VALUES ('C')", []);
  const user = (
    key: string,
    tenant: string | null,
    email: string,
    role: string,
    pwd: string | null,
    google: string | null,
    lastLogin: string | null,
  ) =>
    one(
      key,
      `INSERT INTO users (tenant_id, email, role, password_hash, google_id, last_login_at)
       VALUES ($1, $2, $3::"UserRole", $4, $5, $6)`,
      [tenant, email, role, pwd, google, lastLogin],
    );
  // Ana: two tenants, the B row logged in last, and the email differs in case.
  await user(
    "anaA",
    ids.A as string,
    "ana@x.test",
    "AGENT",
    "hA",
    null,
    "2026-01-01",
  );
  await user(
    "anaB",
    ids.B as string,
    "ANA@x.test",
    "TENANT_ADMIN",
    "hB",
    "g-ana",
    "2026-06-01",
  );
  // Bia: neither row ever logged in, so the tie goes to the older row; the Google identity lives on
  // the row that goes, and has to survive the merge.
  await user("biaA", ids.A as string, "bia@x.test", "AGENT", "p1", null, null);
  await user(
    "biaB",
    ids.B as string,
    "bia@x.test",
    "AGENT",
    null,
    "g-bia",
    null,
  );
  // Root: a fleet administrator who also had a tenant row, which logged in more recently.
  await user(
    "rootFleet",
    null,
    "root@x.test",
    "SUPER_ADMIN",
    "hR",
    null,
    "2025-01-01",
  );
  await user(
    "rootA",
    ids.A as string,
    "root@x.test",
    "AGENT",
    "hRA",
    null,
    "2026-02-01",
  );
  // Cai: THREE rows. The two that go both approved a client the one that stays never did, which is
  // the collision a per-pair de-duplication misses (review round 1).
  await user(
    "caiA",
    ids.A as string,
    "cai@x.test",
    "AGENT",
    "c1",
    null,
    "2026-07-01",
  );
  await user(
    "caiB",
    ids.B as string,
    "cai@x.test",
    "AGENT",
    "c2",
    null,
    "2026-02-01",
  );
  await user(
    "caiC",
    ids.C as string,
    "cai@x.test",
    "AGENT",
    "c3",
    null,
    "2026-03-01",
  );
  // Solo: one tenant, nothing to merge.
  await user("solo", ids.A as string, "solo@x.test", "AGENT", "hS", null, null);

  await c.query(
    "INSERT INTO invitations (tenant_id, invited_by_id) VALUES ($1, $2)",
    [ids.A, ids.anaA],
  );
  await c.query("INSERT INTO mcp_oauth_access_tokens (user_id) VALUES ($1)", [
    ids.anaA,
  ]);
  await c.query("INSERT INTO mcp_oauth_refresh_tokens (user_id) VALUES ($1)", [
    ids.anaA,
  ]);
  await c.query(
    "INSERT INTO mcp_oauth_authorization_codes (user_id) VALUES ($1)",
    [ids.anaA],
  );
  await c.query(
    "INSERT INTO mcp_oauth_pending_authorizations (user_id) VALUES ($1)",
    [ids.anaA],
  );
  // The same client approved from both of Ana's rows, and another from the row that goes.
  await c.query(
    "INSERT INTO mcp_oauth_client_approvals (user_id, client_id) VALUES ($1, 'c1'), ($2, 'c1'), ($1, 'c2')",
    [ids.anaA, ids.anaB],
  );
  await c.query(
    "INSERT INTO mcp_oauth_client_approvals (user_id, client_id) VALUES ($1, 'c9'), ($2, 'c9')",
    [ids.caiB, ids.caiC],
  );
  // A key minted by the row that goes, and one by the row that stays.
  await c.query(
    "INSERT INTO api_keys (tenant_id, created_by_user_id) VALUES ($1, $2), ($3, $4)",
    [ids.A, ids.anaA, ids.B, ids.anaB],
  );
  return ids;
}

interface Outcome {
  failed: string | null;
  notices: string[];
  ids: Ids;
  c: Client;
}

// The previous run's connection, closed before its database is dropped: `DROP ... WITH (FORCE)`
// would otherwise cut it, and the client reports that as an error from whatever test is running.
let previous: Client | undefined;

async function migrate(text: string): Promise<Outcome> {
  const suDb = su as Client;
  await previous?.end().catch(() => {});
  previous = undefined;
  await suDb.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
  await suDb.query(`CREATE DATABASE ${PROBE_DB}`);
  const c = new Client({ connectionString: probeUrl() });
  await c.connect();
  previous = c;
  const notices: string[] = [];
  c.on("notice", (n) => notices.push(n.message ?? ""));
  await c.query(`ALTER SCHEMA public OWNER TO ${PROBE_OWNER}`);
  await c.query(`SET ROLE ${PROBE_OWNER}`);
  await c.query(OLD_SHAPE);
  const ids = await seed(c);
  await c.query(LOCK_DOWN);
  let failed: string | null = null;
  try {
    for (const statement of statementsOf(text)) await c.query(statement);
  } catch (e) {
    failed = (e as Error).message;
    await c.query("ROLLBACK").catch(() => {});
  }
  // The assertions read every row, whatever the policy says.
  await c.query("RESET ROLE");
  return { failed, notices, ids, c };
}

const people = (c: Client) =>
  c
    .query<{
      id: string;
      email: string;
      password_hash: string | null;
      google_id: string | null;
      is_super_admin: boolean;
      memberships: string | null;
    }>(
      `SELECT u.id::text, lower(u.email) AS email, u.password_hash, u.google_id, u.is_super_admin,
              string_agg(t.name || ':' || m.role::text, ',' ORDER BY t.name) AS memberships
         FROM users u
         LEFT JOIN tenant_users m ON m.user_id = u.id
         LEFT JOIN tenants t ON t.id = m.tenant_id
        GROUP BY u.id ORDER BY lower(u.email)`,
    )
    .then((r) => r.rows);

describe.skipIf(!dbUp)("the tenant_users migration", () => {
  afterAll(async () => {
    await previous?.end().catch(() => {});
    if (su) {
      await su.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
      await su.query(`DROP ROLE IF EXISTS ${PROBE_OWNER}`);
      await su.end();
    }
  });

  test("one person per email, keeping the password of the most recent login", async () => {
    const { failed, ids, c } = await migrate(sql);
    expect(failed).toBeNull();
    expect(await people(c)).toEqual([
      {
        id: ids.anaB as string,
        email: "ana@x.test",
        password_hash: "hB",
        google_id: "g-ana",
        is_super_admin: false,
        memberships: "A:AGENT,B:TENANT_ADMIN",
      },
      {
        id: ids.biaA as string,
        email: "bia@x.test",
        password_hash: "p1",
        google_id: "g-bia",
        is_super_admin: false,
        memberships: "A:AGENT,B:AGENT",
      },
      {
        id: ids.caiA as string,
        email: "cai@x.test",
        password_hash: "c1",
        google_id: null,
        is_super_admin: false,
        memberships: "A:AGENT,B:AGENT,C:AGENT",
      },
      {
        id: ids.rootA as string,
        email: "root@x.test",
        password_hash: "hRA",
        google_id: null,
        is_super_admin: true,
        memberships: "A:AGENT",
      },
      {
        id: ids.solo as string,
        email: "solo@x.test",
        password_hash: "hS",
        google_id: null,
        is_super_admin: false,
        memberships: "A:AGENT",
      },
    ]);
  });

  test("what named a merged row names the person that stayed", async () => {
    const { ids, c } = await migrate(sql);
    const col = async (table: string, column: string) =>
      (
        await c.query<{ v: string }>(
          `SELECT ${column}::text AS v FROM ${table} ORDER BY id`,
        )
      ).rows.map((r) => r.v);
    expect(await col("invitations", "invited_by_id")).toEqual([
      ids.anaB as string,
    ]);
    for (const table of [
      "mcp_oauth_access_tokens",
      "mcp_oauth_refresh_tokens",
      "mcp_oauth_authorization_codes",
      "mcp_oauth_pending_authorizations",
    ]) {
      expect(await col(table, "user_id")).toEqual([ids.anaB as string]);
    }
    // The client both rows approved keeps ONE approval, and the other moves.
    const approvals = (
      await c.query<{ user_id: string; client_id: string }>(
        "SELECT user_id::text, client_id FROM mcp_oauth_client_approvals ORDER BY client_id",
      )
    ).rows;
    expect(approvals).toEqual([
      { user_id: ids.anaB as string, client_id: "c1" },
      { user_id: ids.anaB as string, client_id: "c2" },
      { user_id: ids.caiA as string, client_id: "c9" },
    ]);
    // An API key's creator answers the step-up for a key minted before it had its own, so a key made
    // by the row that went is now the person's. The table is FORCE-RLS, and stays so.
    expect(await col("api_keys", "created_by_user_id")).toEqual([
      ids.anaB as string,
      ids.anaB as string,
    ]);
    const forced = (
      await c.query<{ relname: string; f: boolean }>(
        "SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('api_keys', 'audit_logs') ORDER BY relname",
      )
    ).rows;
    expect(forced).toEqual([
      { relname: "api_keys", f: true },
      { relname: "audit_logs", f: true },
    ]);
  });

  // `prisma migrate deploy` does not print a NOTICE, so the record the operator can find is the
  // audit trail: one row in the fleet trail and one in each tenant the person now belongs to.
  test("every merge is written to the audit trail, and nothing else is", async () => {
    const { ids, c } = await migrate(sql);
    const rows = (
      await c.query<{
        tenant: string | null;
        target: string;
        before: unknown;
        after: unknown;
      }>(
        `SELECT t.name AS tenant, a.target, a."before", a."after"
           FROM audit_logs a LEFT JOIN tenants t ON t.id = a.tenant_id
          WHERE a.action = 'user.merged_by_upgrade' AND a.actor_type = 'system' AND a.actor_id IS NULL
          ORDER BY a.target, t.name NULLS FIRST`,
      )
    ).rows;
    const ana = rows.filter((r) => r.target === `user:${ids.anaB}`);
    expect(ana.map((r) => r.tenant)).toEqual([null, "A", "B"]);
    expect(ana[0]?.before).toEqual({ userIds: [ids.anaA] });
    expect(ana[0]?.after).toEqual({ userId: ids.anaB, email: "ana@x.test" });
    expect(new Set(rows.map((r) => r.target))).toEqual(
      new Set([
        `user:${ids.anaB}`,
        `user:${ids.biaA}`,
        `user:${ids.rootA}`,
        `user:${ids.caiA}`,
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain("solo@x.test");
  });

  test("the deploy log names every merge", async () => {
    const { notices, ids } = await migrate(sql);
    const merged = notices.filter((n) => n.startsWith("tenant_users: merged"));
    expect(merged).toHaveLength(4);
    expect(merged.join("\n")).toContain(`into user ${ids.anaB} (ana@x.test)`);
    expect(merged.join("\n")).toContain(`into user ${ids.biaA} (bia@x.test)`);
    expect(merged.join("\n")).toContain(`into user ${ids.rootA} (root@x.test)`);
    expect(merged.join("\n")).toContain(`into user ${ids.caiA} (cai@x.test)`);
  });

  test("the old columns stay for the previous image, and bind nothing any more", async () => {
    const { ids, c } = await migrate(sql);
    // The previous image names both on every cookie request during the deploy, so they stay one
    // release, holding what they held (.claude/rules/prisma.md, "Dropping a column").
    const cols = (
      await c.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('tenant_id', 'role') ORDER BY column_name",
      )
    ).rows.map((r) => r.column_name);
    expect(cols).toEqual(["role", "tenant_id"]);
    const frozen = (
      await c.query<{ tenant_id: string; role: string }>(
        "SELECT tenant_id::text, role::text FROM users WHERE id = $1",
        [ids.anaB],
      )
    ).rows[0];
    expect(frozen).toEqual({
      tenant_id: ids.B as string,
      role: "TENANT_ADMIN",
    });
    // A row the new image writes carries neither, and the constraint that tied them is gone.
    await c.query(
      "INSERT INTO users (email, password_hash, updated_at) VALUES ('new@x.test', 'x', now())",
    );
    // And the foreign key's cascade is gone: deleting the tenant an old row pointed at takes the
    // membership, never the PERSON with every other membership.
    await c.query("DELETE FROM tenants WHERE id = $1", [ids.B]);
    expect(
      (await c.query("SELECT id FROM users WHERE id = $1", [ids.anaB])).rows,
    ).toHaveLength(1);
    expect(
      (
        await c.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM tenant_users WHERE user_id = $1",
          [ids.anaB],
        )
      ).rows[0]?.n,
    ).toBe("1");
  });

  // Review round 3: a rollout that migrates while the previous image still serves leaves it writing the
  // old shape. What it writes reaches the new one, so nobody it invites is locked out and no role
  // change it makes is lost.
  test("the previous image's writes reach the memberships while the columns exist", async () => {
    const { ids, c } = await migrate(sql);
    const membership = async (userId: string) =>
      (
        await c.query<{ tenant: string; role: string }>(
          `SELECT t.name AS tenant, m.role::text AS role FROM tenant_users m
             JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 ORDER BY t.name`,
          [userId],
        )
      ).rows;
    // An invitation it accepts: a row with a tenant and a role, and nothing else.
    const invited = (
      await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, role, password_hash, updated_at)
         VALUES ($1, 'late@x.test', 'AGENT', 'x', now()) RETURNING id::text`,
        [ids.B],
      )
    ).rows[0]?.id as string;
    expect(await membership(invited)).toEqual([{ tenant: "B", role: "AGENT" }]);
    // A role change it makes in the tenant the row names.
    await c.query("UPDATE users SET role = 'TENANT_ADMIN' WHERE id = $1", [
      invited,
    ]);
    expect(await membership(invited)).toEqual([
      { tenant: "B", role: "TENANT_ADMIN" },
    ]);
    // Its fleet demotion: the person leaves the fleet and lands in the tenant it names.
    const fleet = (
      await c.query<{ id: string }>(
        `INSERT INTO users (email, role, password_hash, is_super_admin, updated_at)
         VALUES ('fleet@x.test', 'SUPER_ADMIN', 'x', true, now()) RETURNING id::text`,
      )
    ).rows[0]?.id as string;
    await c.query(
      "UPDATE users SET role = 'AGENT', tenant_id = $2 WHERE id = $1",
      [fleet, ids.B],
    );
    const demoted = (
      await c.query<{ s: boolean }>(
        "SELECT is_super_admin AS s FROM users WHERE id = $1",
        [fleet],
      )
    ).rows[0]?.s;
    expect(demoted).toBe(false);
    expect(await membership(fleet)).toEqual([{ tenant: "B", role: "AGENT" }]);
    // A write of this image names neither column and fires nothing.
    await c.query("UPDATE users SET name = 'x' WHERE id = $1", [ids.anaB]);
    expect(await membership(ids.anaB as string)).toEqual([
      { tenant: "A", role: "AGENT" },
      { tenant: "B", role: "TENANT_ADMIN" },
    ]);
  });

  test("the new shape refuses what it has to", async () => {
    const { ids, c } = await migrate(sql);
    // One person per email across the install, whatever the case.
    await expect(
      c.query(
        "INSERT INTO users (email, password_hash, updated_at) VALUES ('SOLO@x.test', 'x', now())",
      ),
    ).rejects.toThrow(/users_email_key/);
    // The fleet role is the person's, never a membership's.
    await expect(
      c.query(
        `INSERT INTO tenant_users (tenant_id, user_id, role, updated_at) VALUES ($1, $2, 'SUPER_ADMIN', now())`,
        [ids.B, ids.solo],
      ),
    ).rejects.toThrow(/tenant_users_role_not_superadmin_check/);
    // One membership per (tenant, person).
    await expect(
      c.query(
        `INSERT INTO tenant_users (tenant_id, user_id, role, updated_at) VALUES ($1, $2, 'AGENT', now())`,
        [ids.A, ids.solo],
      ),
    ).rejects.toThrow(/tenant_users_tenant_id_user_id_key/);
  });

  // The file opens its own transaction because it deletes rows and then drops the columns the merge
  // read: stopping between the two must leave the old shape whole, or the retry meets a table that
  // already exists and people half merged.
  test("a failure after the merge leaves nothing of it behind", async () => {
    const broken = sql.replace(
      'ALTER TABLE "users" DROP CONSTRAINT "users_role_tenant_check";',
      'SELECT 1 / 0;\nALTER TABLE "users" DROP CONSTRAINT "users_role_tenant_check";',
    );
    expect(broken).not.toBe(sql);
    const { failed, c } = await migrate(broken);
    expect(failed).toContain("division by zero");
    const rows = (await c.query("SELECT id FROM users")).rows;
    expect(rows).toHaveLength(10);
    const table = (await c.query("SELECT to_regclass('tenant_users') AS t"))
      .rows[0]?.t;
    expect(table).toBeNull();
  });
});
