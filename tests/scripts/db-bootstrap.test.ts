import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { planRoleProvisioning } from "../../scripts/db-bootstrap";

// The bug this file exists for only exists on a database whose ADMINISTRATIVE role is not a real
// superuser, which is every managed Postgres (RDS, Coolify, EasyPanel) and no local docker one. So
// the fixture builds that shape for real: a CREATEROLE/NOSUPERUSER admin owning its own database,
// and the actual `scripts/db-bootstrap.ts` run against it as a subprocess, exactly as the image
// CMD runs it. Nothing here mocks Postgres — the privilege checks under test are the server's.
const suUrl = process.env.MIGRATION_DATABASE_URL;
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

const ADMIN_ROLE = `fazerai_bs_admin_${process.pid}`;
const APP_ROLE = `fazerai_bs_app_${process.pid}`;
const FOREIGN_ROLE = `fazerai_bs_foreign_${process.pid}`;
const PROBE_DB = `fazerai_bs_probe_${process.pid}`;
const ADMIN_PW = "bs-admin-pw";
const APP_PW = "bs-app-pw";
const ROTATED_PW = "bs-app-pw-rotated";
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function urlFor(user: string, password: string, database: string): string {
  const u = new URL(suUrl as string);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

async function runBootstrap(appPassword = APP_PW, appRole = APP_ROLE) {
  const proc = Bun.spawn(["bun", "scripts/db-bootstrap.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB),
      DATABASE_URL: urlFor(appRole, appPassword, PROBE_DB),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function onProbe<T>(
  url: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// The decision the whole change turns on, as a table: which statement each catalog state earns.
// It is separated from the database because what makes it right is a privilege rule, not a
// connection — and because the e2e below can only reach three of these five rows.
describe("planRoleProvisioning", () => {
  const cases: [
    string,
    Parameters<typeof planRoleProvisioning>[0],
    ReturnType<typeof planRoleProvisioning>,
  ][] = [
    [
      "a role that does not exist is created, with the full attribute list",
      {
        exists: false,
        isSuperuser: false,
        bypassesRls: false,
        hasCreateDb: false,
        hasCreateRole: false,
      },
      "create",
    ],
    [
      "an existing, unprivileged role has only its password re-asserted",
      {
        exists: true,
        isSuperuser: false,
        bypassesRls: false,
        hasCreateDb: false,
        hasCreateRole: false,
      },
      "syncPassword",
    ],
    [
      "an existing SUPERUSER role is demoted, because RLS is a no-op for it",
      {
        exists: true,
        isSuperuser: true,
        bypassesRls: false,
        hasCreateDb: false,
        hasCreateRole: false,
      },
      "demote",
    ],
    [
      "an existing BYPASSRLS role is demoted for the same reason",
      {
        exists: true,
        isSuperuser: false,
        bypassesRls: true,
        hasCreateDb: false,
        hasCreateRole: false,
      },
      "demote",
    ],
    [
      "both attributes at once is still one demotion",
      {
        exists: true,
        isSuperuser: true,
        bypassesRls: true,
        hasCreateDb: false,
        hasCreateRole: false,
      },
      "demote",
    ],
    // CREATEDB and CREATEROLE do not change the PLAN, and that is the point rather than an
    // omission: neither defeats RLS, so neither is worth failing a boot over. They are stripped
    // alongside the password sync, one statement each, so that a partial strip still happens.
    [
      "CREATEDB alone does not turn a password sync into a demotion",
      {
        exists: true,
        isSuperuser: false,
        bypassesRls: false,
        hasCreateDb: true,
        hasCreateRole: false,
      },
      "syncPassword",
    ],
    [
      "neither does CREATEROLE",
      {
        exists: true,
        isSuperuser: false,
        bypassesRls: false,
        hasCreateDb: false,
        hasCreateRole: true,
      },
      "syncPassword",
    ],
    [
      "but a SUPERUSER that also has them is still a demotion",
      {
        exists: true,
        isSuperuser: true,
        bypassesRls: false,
        hasCreateDb: true,
        hasCreateRole: true,
      },
      "demote",
    ],
  ];
  for (const [name, state, expected] of cases) {
    test(name, () => {
      expect(planRoleProvisioning(state)).toBe(expected);
    });
  }

  // Regression: the module used to call main() at import time, so importing it to test the
  // decision above would have run a real bootstrap against whatever the environment pointed at.
  test("importing the script does not run the bootstrap", () => {
    expect(
      planRoleProvisioning({
        exists: false,
        isSuperuser: false,
        bypassesRls: false,
        hasCreateDb: false,
        hasCreateRole: false,
      }),
    ).toBe("create");
  });
});

describe.skipIf(!dbUp)(
  "db-bootstrap against a non-superuser admin role",
  () => {
    // NOTE: these run in order and share state on purpose — they walk one install's lifecycle
    // (first boot, later boot, a rotated password, a privileged role, a role we did not create, a
    // schema we do not own), which is the shape the failures actually come in. Running one alone
    // with `-t` skips the boot that created the role and fails on a missing role, not on the
    // behaviour under test.
    beforeAll(async () => {
      const db = su as Client;
      // Roles and databases are CLUSTER-WIDE catalogs that Postgres does not serialize for
      // concurrent DDL. tests/lib/db-guard.test.ts takes this same advisory lock id for the same
      // reason; a SESSION-level lock is what covers the subprocess, whose own role DDL we do not
      // control. Both suites therefore take their turn instead of racing to `tuple concurrently
      // updated`.
      await db.query("SELECT pg_advisory_lock(729104553)");
      await db.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await db.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${FOREIGN_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${ADMIN_ROLE}`);
      // The shape of an RDS master user / a Coolify-provisioned owner: it can create roles and owns
      // the database, and `rolsuper` is false.
      await db.query(
        `CREATE ROLE ${ADMIN_ROLE} LOGIN PASSWORD '${ADMIN_PW}' CREATEROLE NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(`CREATE DATABASE ${PROBE_DB} OWNER ${ADMIN_ROLE}`);
      // pgvector is installed here by the SUPERUSER on purpose. `CREATE EXTENSION` is a separate
      // privilege question with a separate answer (on RDS the master user may install it; a
      // non-superuser on a plain server may not), and it is not what this file measures. Leaving it
      // out would fail the script one statement earlier, on something this change does not touch.
      const admin = new URL(suUrl as string);
      await onProbe(urlFor(admin.username, admin.password, PROBE_DB), (c) =>
        c.query("CREATE EXTENSION IF NOT EXISTS vector"),
      );
    });

    afterAll(async () => {
      const db = su as Client;
      await db.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await db.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${FOREIGN_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${ADMIN_ROLE}`);
      await db.query("SELECT pg_advisory_unlock(729104553)");
      await db.end();
    });

    test("the first boot provisions the runtime role and the langgraph schema", async () => {
      const { exitCode, stdout, stderr } = await runBootstrap();
      expect(`${stdout}${stderr}`).not.toContain("must be able to SET ROLE");
      expect(exitCode).toBe(0);

      const role = await onProbe(
        urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB),
        async (c) =>
          (
            await c.query(
              "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1",
              [APP_ROLE],
            )
          ).rows[0],
      );
      expect(role).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcanlogin: true,
      });

      const schema = await onProbe(
        urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB),
        async (c) =>
          (
            await c.query(
              "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'langgraph'",
            )
          ).rows[0],
      );
      expect(schema).toEqual({ owner: APP_ROLE });
    });

    test("every later boot completes too, so the service is not left crash-looping", async () => {
      const { exitCode, stdout, stderr } = await runBootstrap();
      expect(`${stdout}${stderr}`).not.toContain(
        "permission denied to alter role",
      );
      expect(exitCode).toBe(0);
    });

    test("the provisioned role can connect with the password from DATABASE_URL", async () => {
      const who = await onProbe(
        urlFor(APP_ROLE, APP_PW, PROBE_DB),
        async (c) =>
          (await c.query("SELECT current_user")).rows[0].current_user,
      );
      expect(who).toBe(APP_ROLE);
    });

    test("a rotated password in DATABASE_URL is applied to the existing role", async () => {
      const { exitCode } = await runBootstrap(ROTATED_PW);
      expect(exitCode).toBe(0);
      const who = await onProbe(
        urlFor(APP_ROLE, ROTATED_PW, PROBE_DB),
        async (c) =>
          (await c.query("SELECT current_user")).rows[0].current_user,
      );
      expect(who).toBe(APP_ROLE);
    });

    test("elevated attributes that do not defeat RLS are still taken away", async () => {
      const db = su as Client;
      // Before this script branched by catalog state, every boot re-asserted one option list, so a
      // role that picked up CREATEDB or CREATEROLE lost them again on the next boot. Nothing
      // downstream notices these two -- the boot guard only reads rolsuper/rolbypassrls -- so this
      // script is the only thing that takes them away.
      await db.query(`ALTER ROLE ${APP_ROLE} CREATEDB CREATEROLE`);

      const { exitCode, stdout, stderr } = await runBootstrap(ROTATED_PW);
      expect(exitCode).toBe(0);

      // Partial, and deliberately so: an administrator may only set an attribute it holds itself,
      // and this one has CREATEROLE and not CREATEDB. One statement each is what makes the half it
      // CAN do still happen; a combined statement would lose both to the one it is refused.
      const after = await onProbe(
        urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB),
        async (c) =>
          (
            await c.query(
              "SELECT rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
              [APP_ROLE],
            )
          ).rows[0],
      );
      expect(after).toEqual({ rolcreatedb: true, rolcreaterole: false });
      expect(`${stdout}${stderr}`).toContain("NOCREATEDB");

      await db.query(`ALTER ROLE ${APP_ROLE} NOCREATEDB`);
    });

    test("a runtime role that IS privileged is refused, in terms the operator can act on", async () => {
      const db = su as Client;
      // Only a superuser can privilege it in the first place, which is the point: the script has to
      // say something useful when it finds one it cannot demote.
      await db.query(`ALTER ROLE ${APP_ROLE} BYPASSRLS`);
      const { exitCode, stdout, stderr } = await runBootstrap(ROTATED_PW);
      const output = `${stdout}${stderr}`;
      expect(exitCode).toBe(1);
      expect(output).toContain(APP_ROLE);
      expect(output).toMatch(/BYPASSRLS|SUPERUSER/);
      expect(output).toContain("NOSUPERUSER NOBYPASSRLS");
      await db.query(`ALTER ROLE ${APP_ROLE} NOBYPASSRLS`);
    });

    test("a runtime role this administrator did not create still boots", async () => {
      const db = su as Client;
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // Created by the SUPERUSER, so the administrative role holds no ADMIN over it. Three
      // statements are then refused at once: the password sync, the membership grant, and the
      // schema's AUTHORIZATION. None of them is the guarantee this script owes, so a brownfield
      // install has to boot through all three instead of crash-looping on them.
      await db.query(
        `CREATE ROLE ${FOREIGN_ROLE} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(
        `GRANT CONNECT ON DATABASE ${PROBE_DB} TO ${FOREIGN_ROLE}`,
      );
      // The schema survives from the tests above, and `IF NOT EXISTS` short-circuits before the
      // privilege check — which would hide the very statement this test is about.
      await onProbe(superuserOnProbe, (c) =>
        c.query("DROP SCHEMA IF EXISTS langgraph CASCADE"),
      );

      const { exitCode, stdout, stderr } = await runBootstrap(
        APP_PW,
        FOREIGN_ROLE,
      );
      expect(`${stdout}${stderr}`).toContain(
        "could not create the langgraph schema",
      );
      expect(exitCode).toBe(0);

      // It skipped the schema rather than pretending: what makes that safe is that the runtime
      // role can create it itself, which is exactly what PostgresSaver.setup() does at boot.
      const before = await onProbe(
        superuserOnProbe,
        async (c) =>
          (
            await c.query(
              "SELECT to_regnamespace('langgraph') IS NOT NULL AS present",
            )
          ).rows[0],
      );
      expect(before).toEqual({ present: false });
      const owner = await onProbe(
        urlFor(FOREIGN_ROLE, APP_PW, PROBE_DB),
        async (c) => {
          await c.query("CREATE SCHEMA IF NOT EXISTS langgraph");
          return (
            await c.query(
              "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'langgraph'",
            )
          ).rows[0];
        },
      );
      expect(owner).toEqual({ owner: FOREIGN_ROLE });
    });

    test("a langgraph schema owned by someone else is not silently accepted", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // A rotated runtime role lands here: the schema is left behind under the previous owner.
      // `CREATE SCHEMA IF NOT EXISTS` is a no-op there, for us AND for PostgresSaver.setup(), so
      // nothing downstream can repair it — the checkpointer would fail at boot on schema access.
      // Warning and reporting success is the one outcome that must not happen.
      //
      // The previous owner has to be a role the administrator cannot act as, which is what makes
      // the GRANT fail: it holds SET membership over the roles it created (taken above, for the
      // AUTHORIZATION), and none over FOREIGN_ROLE, which the superuser created.
      await onProbe(superuserOnProbe, async (c) => {
        await c.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
        await c.query(`CREATE SCHEMA langgraph AUTHORIZATION ${FOREIGN_ROLE}`);
        // The table matters as much as the schema: PostgresSaver.setup() opens with
        // `SELECT v FROM langgraph.checkpoint_migrations`, and granting on a schema does not reach
        // what is inside it.
        await c.query(`CREATE TABLE langgraph.checkpoint_migrations (v int)`);
        await c.query(
          `ALTER TABLE langgraph.checkpoint_migrations OWNER TO ${FOREIGN_ROLE}`,
        );
      });

      const { exitCode, stdout, stderr } = await runBootstrap(
        ROTATED_PW,
        APP_ROLE,
      );
      const output = `${stdout}${stderr}`;
      expect(exitCode).toBe(1);
      expect(output).toContain(FOREIGN_ROLE);
      expect(output).toContain("checkpoint_migrations");
      expect(output).toContain("GRANT USAGE, CREATE ON SCHEMA langgraph");
    });

    test("a reachable schema whose TABLES are not is still refused", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // The discriminating case, and the one the schema grant alone would hide: access to the
      // schema says nothing about access to what is inside it. Here the runtime role is given
      // USAGE/CREATE outright, so only the table it reads first is out of reach.
      await onProbe(superuserOnProbe, (c) =>
        c.query(`GRANT USAGE, CREATE ON SCHEMA langgraph TO ${APP_ROLE}`),
      );

      const { exitCode, stdout, stderr } = await runBootstrap(
        ROTATED_PW,
        APP_ROLE,
      );
      const output = `${stdout}${stderr}`;
      expect(exitCode).toBe(1);
      expect(output).toContain("the tables already in it");
      expect(output).not.toContain("the schema itself");

      // And read access is not enough either: setup() writes to that same table
      // (`INSERT INTO langgraph.checkpoint_migrations`) right after reading it, so a check that
      // only asked for SELECT would wave through a boot that fails one statement later.
      await onProbe(superuserOnProbe, (c) =>
        c.query(
          `GRANT SELECT ON langgraph.checkpoint_migrations TO ${APP_ROLE}`,
        ),
      );
      const readOnly = await runBootstrap(ROTATED_PW, APP_ROLE);
      expect(readOnly.exitCode).toBe(1);
      expect(`${readOnly.stdout}${readOnly.stderr}`).toContain(
        "the tables already in it",
      );

      // With the full DML set the install works TODAY, so it boots — with a warning, because
      // setup() also runs the checkpointer's migrations and one of them ALTERs those tables, which
      // only their owner may do. Refusing here would crash-loop a server that starts fine.
      await onProbe(superuserOnProbe, (c) =>
        c.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph TO ${APP_ROLE}`,
        ),
      );
      const dmlOnly = await runBootstrap(ROTATED_PW, APP_ROLE);
      expect(dmlOnly.exitCode).toBe(0);
      expect(`${dmlOnly.stdout}${dmlOnly.stderr}`).toContain("does not own");
    });

    test("a rotation the administrator CAN complete is completed, tables included", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // Same shape as above, except the administrator is given the membership that lets it grant
      // on the previous owner's objects. The point is that bootstrap then finishes the rotation
      // rather than refusing: the refusal above is about what it cannot do, not about the case.
      await onProbe(superuserOnProbe, (c) =>
        c.query(`GRANT ${FOREIGN_ROLE} TO ${ADMIN_ROLE} WITH SET TRUE`),
      );

      const { exitCode } = await runBootstrap(ROTATED_PW, APP_ROLE);
      expect(exitCode).toBe(0);

      // To the effect, not to the exit code: the runtime role reads the table the checkpointer
      // reads first, AND owns it — which is what lets setup() run the migration that ALTERs it.
      const state = await onProbe(
        urlFor(APP_ROLE, ROTATED_PW, PROBE_DB),
        async (c) => ({
          rows: (await c.query("SELECT v FROM langgraph.checkpoint_migrations"))
            .rows,
          owner: (
            await c.query(
              "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'langgraph.checkpoint_migrations'::regclass",
            )
          ).rows[0].owner,
        }),
      );
      expect(state).toEqual({ rows: [], owner: APP_ROLE });
    });
  },
);
