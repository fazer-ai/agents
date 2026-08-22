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

async function runBootstrap(appPassword = APP_PW) {
  const proc = Bun.spawn(["bun", "scripts/db-bootstrap.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB),
      DATABASE_URL: urlFor(APP_ROLE, appPassword, PROBE_DB),
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
      { exists: false, isSuperuser: false, bypassesRls: false },
      "create",
    ],
    [
      "an existing, unprivileged role has only its password re-asserted",
      { exists: true, isSuperuser: false, bypassesRls: false },
      "syncPassword",
    ],
    [
      "an existing SUPERUSER role is demoted, because RLS is a no-op for it",
      { exists: true, isSuperuser: true, bypassesRls: false },
      "demote",
    ],
    [
      "an existing BYPASSRLS role is demoted for the same reason",
      { exists: true, isSuperuser: false, bypassesRls: true },
      "demote",
    ],
    [
      "both attributes at once is still one demotion",
      { exists: true, isSuperuser: true, bypassesRls: true },
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
      }),
    ).toBe("create");
  });
});

describe.skipIf(!dbUp)(
  "db-bootstrap against a non-superuser admin role",
  () => {
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
      await onProbe(
        urlFor("postgres", new URL(suUrl as string).password, PROBE_DB),
        (c) => c.query("CREATE EXTENSION IF NOT EXISTS vector"),
      );
    });

    afterAll(async () => {
      const db = su as Client;
      await db.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await db.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
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
  },
);
