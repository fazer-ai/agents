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
// file's own (.claude/rules/prisma.md, #555).

const MIGRATION = "prisma/migrations/20260925000000_tenant_users/migration.sql";
const sql = await Bun.file(MIGRATION).text();

const suUrl = process.env.MIGRATION_DATABASE_URL;
const PROBE_DB = `fazerai_tenant_users_${process.pid}`;
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
`;

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
  await c.query(OLD_SHAPE);
  const ids = await seed(c);
  let failed: string | null = null;
  try {
    for (const statement of statementsOf(text)) await c.query(statement);
  } catch (e) {
    failed = (e as Error).message;
    await c.query("ROLLBACK").catch(() => {});
  }
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
    ]);
  });

  test("the deploy log names every merge", async () => {
    const { notices, ids } = await migrate(sql);
    const merged = notices.filter((n) => n.startsWith("tenant_users: merged"));
    expect(merged).toHaveLength(3);
    expect(merged.join("\n")).toContain(`into user ${ids.anaB} (ana@x.test)`);
    expect(merged.join("\n")).toContain(`into user ${ids.biaA} (bia@x.test)`);
    expect(merged.join("\n")).toContain(`into user ${ids.rootA} (root@x.test)`);
  });

  test("the old shape is gone, and the new one refuses what it has to", async () => {
    const { ids, c } = await migrate(sql);
    const cols = (
      await c.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('tenant_id', 'role')",
      )
    ).rows;
    expect(cols).toEqual([]);
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
    expect(rows).toHaveLength(7);
    const table = (await c.query("SELECT to_regclass('tenant_users') AS t"))
      .rows[0]?.t;
    expect(table).toBeNull();
  });
});
