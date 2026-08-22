import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  assertRuntimeRoleIsUnprivileged,
  parseAppRole,
  planRoleProvisioning,
} from "../../scripts/db-bootstrap";

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
const UNREACHABLE_ROLE = `fazerai_bs_unreachable_${process.pid}`;
const ROT_A_ROLE = `fazerai_bs_rot_a_${process.pid}`;
const ROT_B_ROLE = `fazerai_bs_rot_b_${process.pid}`;
const SOLO_ROLE = `fazerai_bs_solo_${process.pid}`;
const SPLIT_OWNER = `fazerai_bs_split_${process.pid}`;
const NOINH_ADMIN = `fazerai_bs_noinh_admin_${process.pid}`;
const NOINH_APP = `fazerai_bs_noinh_app_${process.pid}`;
const PRIV_PARENT = `fazerai_bs_priv_parent_${process.pid}`;
const SU_PARENT = `fazerai_bs_su_parent_${process.pid}`;
const TEAM_ROLE = `fazerai_bs_team_${process.pid}`;
const SIDE_ROLE = `fazerai_bs_side_${process.pid}`;
const HEIR_ROLE = `fazerai_bs_heir_${process.pid}`;
const SETONLY_ROLE = `fazerai_bs_setonly_${process.pid}`;
const PRIV_ROLE = `fazerai_bs_priv_${process.pid}`;
const PROBE_DB = `fazerai_bs_probe_${process.pid}`;
const SOLO_DB = `fazerai_bs_solo_db_${process.pid}`;
const NOINH_DB = `fazerai_bs_noinh_db_${process.pid}`;
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

async function runBootstrap(
  appPassword = APP_PW,
  appRole = APP_ROLE,
  extraEnv: Record<string, string> = {},
) {
  const proc = Bun.spawn(["bun", "scripts/db-bootstrap.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB),
      DATABASE_URL: urlFor(appRole, appPassword, PROBE_DB),
      ...extraEnv,
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
    // NOTE: CREATEDB and CREATEROLE do not change the PLAN, and that is the point rather than an
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

  // NOTE: the module used to call main() at import time, so importing it to test the decision
  // above would have run a real bootstrap against whatever the environment pointed at. Asserting
  // that from inside this file is not possible — the import at the top has already happened, and a
  // main() that ran and succeeded would look exactly like one that never ran. So this spawns a
  // fresh process whose environment would make a real bootstrap fail loudly, and watches nothing
  // happen.
  test("importing the script does not run the bootstrap", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        'await import("./scripts/db-bootstrap.ts"); console.log("imported");',
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/nope",
          DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/nope",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ exitCode, stdout: stdout.trim() }).toEqual({
      exitCode: 0,
      stdout: "imported",
    });
    expect(stderr).not.toContain("ECONNREFUSED");
  });

  // NOTE: the role name is interpolated into DDL as a double-quoted identifier, so this regex is
  // the only thing between a role name and the quotes. It is defense in depth rather than a
  // boundary against external input — DATABASE_URL is operator-supplied — but an unquoted-identifier
  // check that accepts a quote is not defense at all, so it gets a table of its own.
  // NOTE: the question the plan table cannot ask, because it is about the role AFTER provisioning.
  // It is a post-condition on a string the catalog produces, so it tests as one.
  // NOTE: the question the plan table cannot ask, because it is about the role AFTER provisioning.
  // It is a post-condition on two strings the catalog produces, so it tests as one.
  describe("assertRuntimeRoleIsUnprivileged", () => {
    test("a role reaching nothing privileged passes", () => {
      expect(() =>
        assertRuntimeRoleIsUnprivileged("app_role", null, null),
      ).not.toThrow();
    });

    test("a direct membership is reported and revoked by the same name", () => {
      const boom = () =>
        assertRuntimeRoleIsUnprivileged(
          "app_role",
          "rds_superuser",
          "rds_superuser",
        );
      expect(boom).toThrow(/reaches a privileged role/);
      expect(boom).toThrow(/REVOKE rds_superuser FROM "app_role"/);
    });

    // NOTE: the case the two arguments exist for. `runtime -> team -> privileged` reaches
    // `privileged`, and revoking THAT from the runtime role is a statement Postgres accepts as a
    // no-op while changing nothing (measured) — the operator would run it, see success, restart,
    // and fail identically. The instruction has to name `team`.
    test("a transitive one is reported by its endpoint and revoked by its edge", () => {
      const boom = () =>
        assertRuntimeRoleIsUnprivileged("app_role", "privileged", "team");
      expect(boom).toThrow(/\(privileged\)/);
      expect(boom).toThrow(/REVOKE team FROM "app_role"/);
      expect(boom).not.toThrow(/REVOKE privileged/);
    });

    // NOTE: reaching something with no revokable edge is possible — the membership can be one this
    // administrator cannot see a direct grant for — and the refusal still has to happen. It says
    // what is wrong and stops offering a statement rather than offering a wrong one.
    test("no revokable edge still refuses, without inventing a statement", () => {
      const boom = () =>
        assertRuntimeRoleIsUnprivileged("app_role", "privileged", null);
      expect(boom).toThrow(/reaches a privileged role/);
      expect(boom).not.toThrow(/REVOKE/);
    });

    // NOTE: the empty string is not "reaches nothing" — `string_agg` returns NULL for no rows, so
    // an empty string could only come from a role actually named "". Treating it as safe would be
    // a falsy check standing in for the absence check the catalog actually makes.
    test("only NULL means it reaches nothing", () => {
      expect(() => assertRuntimeRoleIsUnprivileged("app_role", "", "")).toThrow(
        "reaches a privileged role",
      );
    });
  });

  // NOTE: this reads the script's own source, which is not how anything else here is tested, and
  // the reason is that the failure it guards cannot be reached from this suite: the only servers
  // available run PostgreSQL 17, and the statement in question is one an older server refuses to
  // PARSE. A review round caught `pg_auth_members.inherit_option` — 16-only, added on a boot path
  // that runs everywhere — after it had already shipped into the branch, and nothing red would
  // have said so. So the rule is asserted where it can be: every 16-only spelling in this file
  // lives inside the version gate, and the portable spelling is used everywhere else.
  test("16-only syntax stays behind the version gate", async () => {
    const source = await Bun.file(
      new URL("../../scripts/db-bootstrap.ts", import.meta.url).pathname,
    ).text();
    const gateStart = source.indexOf("if (s.server_version_num >= 160000) {");
    expect(gateStart).toBeGreaterThan(-1);
    const gateEnd = source.indexOf("\n    }", gateStart);
    expect(gateEnd).toBeGreaterThan(gateStart);

    // Spellings PostgreSQL 15 cannot parse or resolve, as they appear in a statement.
    const sixteenOnly = [
      "WITH SET",
      "WITH INHERIT",
      "inherit_option",
      "set_option",
    ];
    const offenders = source
      .split("\n")
      .map((line, i) => ({ line, at: i }))
      .filter(({ line }) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*")) return false;
        return sixteenOnly.some((t) => code.includes(t));
      })
      .filter(({ at }) => {
        const offset = source.split("\n").slice(0, at).join("\n").length;
        return offset < gateStart || offset > gateEnd;
      })
      .map(({ line }) => line.trim());

    expect(offenders).toEqual([]);
  });

  describe("parseAppRole", () => {
    const cases: [string, string, "ok" | "rejects"][] = [
      ["a plain name", "postgres://app_role:pw@h:5432/db", "ok"],
      ["a hyphenated name", "postgres://app-role:pw@h:5432/db", "ok"],
      ["digits", "postgres://app9:pw@h:5432/db", "ok"],
      ["an embedded double quote", "postgres://ap%22p:pw@h:5432/db", "rejects"],
      ["a semicolon", "postgres://app%3Bdrop:pw@h:5432/db", "rejects"],
      ["a space", "postgres://ap%20p:pw@h:5432/db", "rejects"],
      ["an empty role", "postgres://:pw@h:5432/db", "rejects"],
    ];
    for (const [name, url, expected] of cases) {
      test(`${expected === "ok" ? "accepts" : "rejects"} ${name}`, () => {
        if (expected === "ok") {
          expect(parseAppRole(url).role).toMatch(/^[A-Za-z0-9_-]+$/);
        } else {
          expect(() => parseAppRole(url)).toThrow("unsafe app role name");
        }
      });
    }

    // NOTE: separate from the table because it fails on the OTHER field, and a password the URL
    // does not carry is the one input an operator hits by accident: bootstrap would then set the
    // role's password to the empty string and the server would fail to authenticate one step later.
    test("refuses a DATABASE_URL with no password", () => {
      expect(() => parseAppRole("postgres://app_role@h:5432/db")).toThrow(
        "must include the app role's password",
      );
    });
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
      // NOTE: roles and databases are CLUSTER-WIDE catalogs that Postgres does not serialize for
      // concurrent DDL. tests/lib/db-guard.test.ts takes this same advisory lock id for the same
      // reason; a SESSION-level lock is what covers the subprocess, whose own role DDL we do not
      // control. Both suites therefore take their turn instead of racing to `tuple concurrently
      // updated`.
      await db.query("SELECT pg_advisory_lock(729104553)");
      await db.query(`DROP DATABASE IF EXISTS ${SOLO_DB}`);
      await db.query(`DROP DATABASE IF EXISTS ${NOINH_DB}`);
      await db.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await db.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${FOREIGN_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${UNREACHABLE_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${ROT_A_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${ROT_B_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${SOLO_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${SPLIT_OWNER}`);
      await db.query(`DROP ROLE IF EXISTS ${NOINH_ADMIN}`);
      await db.query(`DROP ROLE IF EXISTS ${NOINH_APP}`);
      await db.query(`DROP ROLE IF EXISTS ${HEIR_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${SETONLY_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${PRIV_PARENT}`);
      await db.query(`DROP ROLE IF EXISTS ${SU_PARENT}`);
      await db.query(`DROP ROLE IF EXISTS ${TEAM_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${SIDE_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${PRIV_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${ADMIN_ROLE}`);
      // NOTE: the shape of an RDS master user / a Coolify-provisioned owner: it can create roles and owns
      // the database, and `rolsuper` is false.
      await db.query(
        `CREATE ROLE ${ADMIN_ROLE} LOGIN PASSWORD '${ADMIN_PW}' CREATEROLE NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(`CREATE DATABASE ${PROBE_DB} OWNER ${ADMIN_ROLE}`);
      // NOTE: pgvector is installed here by the SUPERUSER on purpose. `CREATE EXTENSION` is a separate
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
      await db.query(`DROP DATABASE IF EXISTS ${SOLO_DB}`);
      await db.query(`DROP DATABASE IF EXISTS ${NOINH_DB}`);
      await db.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
      await db.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${FOREIGN_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${UNREACHABLE_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${ROT_A_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${ROT_B_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${SOLO_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${SPLIT_OWNER}`);
      await db.query(`DROP ROLE IF EXISTS ${NOINH_ADMIN}`);
      await db.query(`DROP ROLE IF EXISTS ${NOINH_APP}`);
      await db.query(`DROP ROLE IF EXISTS ${HEIR_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${SETONLY_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${PRIV_PARENT}`);
      await db.query(`DROP ROLE IF EXISTS ${SU_PARENT}`);
      await db.query(`DROP ROLE IF EXISTS ${TEAM_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${SIDE_ROLE}`);
      await db.query(`DROP ROLE IF EXISTS ${PRIV_ROLE}`);
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
      // NOTE: before this script branched by catalog state, every boot re-asserted one option list, so a
      // role that picked up CREATEDB or CREATEROLE lost them again on the next boot. Nothing
      // downstream notices these two -- the boot guard only reads rolsuper/rolbypassrls -- so this
      // script is the only thing that takes them away.
      await db.query(`ALTER ROLE ${APP_ROLE} CREATEDB CREATEROLE`);

      const { exitCode, stdout, stderr } = await runBootstrap(ROTATED_PW);
      expect(exitCode).toBe(0);

      // NOTE: partial, and deliberately so: an administrator may only set an attribute it holds itself,
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
      // NOTE: only a superuser can privilege it in the first place, which is the point: the script has to
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
      // NOTE: created by the SUPERUSER, so the administrative role holds no ADMIN over it. Three
      // statements are then refused at once: the password sync, the membership grant, and the
      // schema's AUTHORIZATION. None of them is the guarantee this script owes, so a brownfield
      // install has to boot through all three instead of crash-looping on them.
      await db.query(
        `CREATE ROLE ${FOREIGN_ROLE} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(
        `GRANT CONNECT ON DATABASE ${PROBE_DB} TO ${FOREIGN_ROLE}`,
      );
      // NOTE: the schema survives from the tests above, and `IF NOT EXISTS` short-circuits before the
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

      // NOTE: it skipped the schema rather than pretending: what makes that safe is that the runtime
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
      // NOTE: a rotated runtime role lands here: the schema is left behind under the previous owner.
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
        // NOTE: the table matters as much as the schema: PostgresSaver.setup() opens with
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
      // NOTE: the discriminating case, and the one the schema grant alone would hide: access to the
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

      // NOTE: and read access is not enough either: setup() writes to that same table
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

      // NOTE: with the full DML set the install works TODAY, so it boots — with a warning, because
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
      // NOTE: the named limit of this branch. A checkpointer migration can be pending right now,
      // not only after an upgrade — setup() applies from the last version recorded in
      // checkpoint_migrations, so an interrupted setup leaves the ALTER TABLE one to re-run — and
      // this script cannot tell that state from a settled one without reading a third-party
      // package's migration list. It says so instead of guessing, which is what this asserts.
      expect(`${dmlOnly.stdout}${dmlOnly.stderr}`).toContain(
        "including one already pending from an interrupted setup",
      );
    });

    test("a transfer the administrator COULD do is still not forced through", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: the pair to the grants-only case below. There the administrator could not re-own the
      // tables; here it is given membership in the previous owner, so it can — and the point is
      // that it still does not, because being able to strip a role's privileges says nothing about
      // whether something is still serving on that role. Refusing has to be the rule rather than
      // the symptom of a missing grant, and this is what tells the two apart.
      await onProbe(superuserOnProbe, (c) =>
        c.query(`GRANT ${FOREIGN_ROLE} TO ${ADMIN_ROLE} WITH SET TRUE`),
      );

      const { exitCode, stdout, stderr } = await runBootstrap(
        ROTATED_PW,
        APP_ROLE,
      );
      expect(exitCode).toBe(0);
      expect(`${stdout}${stderr}`).toContain("does not own");

      // NOTE: to the effect, not to the exit code — the runtime role reads the table the
      // checkpointer reads first and writes the one it writes, on a table it does not own.
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
      expect(state).toEqual({ rows: [], owner: FOREIGN_ROLE });
    });

    test("the transfer the script DOES make needs the schema grant to go first", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: the case the script adopts — tables the administrator itself owns, which is what a
      // brownfield install looks like when its DATABASE_URL was the migration account — sitting in
      // a schema owned by someone else. Postgres requires a table's prospective owner to hold
      // CREATE on its schema, so with the transfer attempted before the grants the whole loop rolls
      // back and every table stays put. Ordering is the only thing between working and not.
      await onProbe(superuserOnProbe, async (c) => {
        await c.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
        await c.query(`CREATE SCHEMA langgraph AUTHORIZATION ${FOREIGN_ROLE}`);
      });
      // As the administrator, so the tables are its own — the shape setup() leaves behind when the
      // runtime URL and the migration URL are the same account.
      await onProbe(urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB), (c) =>
        c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)"),
      );

      const { exitCode, stdout, stderr } = await runBootstrap(
        ROTATED_PW,
        APP_ROLE,
      );
      expect(exitCode).toBe(0);
      expect(`${stdout}${stderr}`).not.toContain("does not own");

      const owner = await onProbe(
        superuserOnProbe,
        async (c) =>
          (
            await c.query(
              "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'langgraph.checkpoint_migrations'::regclass",
            )
          ).rows[0],
      );
      expect(owner).toEqual({ owner: APP_ROLE });
    });

    test("when only the grants are available, the grants are what carries it", async () => {
      const db = su as Client;
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: the fallback the design promises, and the only case where the table GRANT is what does the
      // work: transferring ownership needs membership in the NEW owner as well as the old one, so
      // a runtime role this administrator cannot act as leaves the grant as the whole answer.
      await db.query(
        `CREATE ROLE ${UNREACHABLE_ROLE} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(
        `GRANT CONNECT ON DATABASE ${PROBE_DB} TO ${UNREACHABLE_ROLE}`,
      );
      await onProbe(superuserOnProbe, async (c) => {
        await c.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
        await c.query(`CREATE SCHEMA langgraph AUTHORIZATION ${FOREIGN_ROLE}`);
        await c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)");
        await c.query(
          `ALTER TABLE langgraph.checkpoint_migrations OWNER TO ${FOREIGN_ROLE}`,
        );
      });

      const { exitCode, stdout, stderr } = await runBootstrap(
        APP_PW,
        UNREACHABLE_ROLE,
      );
      expect(exitCode).toBe(0);
      expect(`${stdout}${stderr}`).toContain("does not own");

      // NOTE: not owned, but usable: the checkpointer's first read and its write both go through.
      const worked = await onProbe(
        urlFor(UNREACHABLE_ROLE, APP_PW, PROBE_DB),
        async (c) => {
          await c.query(
            "INSERT INTO langgraph.checkpoint_migrations (v) VALUES (1)",
          );
          return (
            await c.query("SELECT v FROM langgraph.checkpoint_migrations")
          ).rows;
        },
      );
      expect(worked).toEqual([{ v: 1 }]);
    });

    test("rolling a rotation back is reconciled, not skipped", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: ownership of the schema and of its tables move independently, so an install can land
      // with the schema on A and the tables on B. Rolling DATABASE_URL back to A then finds a
      // schema A still owns and tables A cannot touch — exactly the state a "the owner already
      // matches, nothing to do" shortcut waves through and the checkpointer then fails on. The
      // tables are not re-owned (B may still be serving), so the grants are what has to land.
      await onProbe(superuserOnProbe, async (c) => {
        await c.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
        await c.query(`CREATE SCHEMA langgraph AUTHORIZATION ${APP_ROLE}`);
        await c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)");
        await c.query(
          `ALTER TABLE langgraph.checkpoint_migrations OWNER TO ${FOREIGN_ROLE}`,
        );
        await c.query(
          `REVOKE ALL ON langgraph.checkpoint_migrations FROM ${APP_ROLE}`,
        );
      });

      const { exitCode } = await runBootstrap(ROTATED_PW, APP_ROLE);
      expect(exitCode).toBe(0);

      const state = await onProbe(
        urlFor(APP_ROLE, ROTATED_PW, PROBE_DB),
        async (c) => {
          await c.query(
            "INSERT INTO langgraph.checkpoint_migrations (v) VALUES (2)",
          );
          return (
            await c.query(
              "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'langgraph.checkpoint_migrations'::regclass",
            )
          ).rows[0];
        },
      );
      expect(state).toEqual({ owner: FOREIGN_ROLE });
    });

    test("a rotation serves the incoming role without cutting off the outgoing one", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: every case above builds its fixture by hand, which is precise but not faithful: it
      // grants the administrator its membership over the previous owner outright, where a real
      // install gets that membership from bootstrap's own `GRANT <role> TO CURRENT_USER WITH SET
      // TRUE` on the boot that created the role. This walks the real path end to end instead.
      //
      // NOTE: and it measures BOTH sides of the overlap, because a rolling deploy has two live
      // containers. The incoming role has to be able to serve; the outgoing one has to keep
      // serving until it is drained, which is what re-owning its tables would take away.
      await onProbe(superuserOnProbe, (c) =>
        c.query("DROP SCHEMA IF EXISTS langgraph CASCADE"),
      );
      const first = await runBootstrap(APP_PW, ROT_A_ROLE);
      expect(first.exitCode).toBe(0);

      // What PostgresSaver.setup() does on that boot, as the runtime role.
      await onProbe(urlFor(ROT_A_ROLE, APP_PW, PROBE_DB), (c) =>
        c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)"),
      );

      // The old container: a live connection on the old role, held across the rotation.
      const serving = new Client({
        connectionString: urlFor(ROT_A_ROLE, APP_PW, PROBE_DB),
      });
      await serving.connect();
      try {
        const rotated = await runBootstrap(APP_PW, ROT_B_ROLE);
        expect(rotated.exitCode).toBe(0);
        expect(`${rotated.stdout}${rotated.stderr}`).toContain("does not own");

        // The incoming role serves: the checkpointer's first read and its write both go through.
        const worked = await onProbe(
          urlFor(ROT_B_ROLE, APP_PW, PROBE_DB),
          async (c) => {
            await c.query(
              "INSERT INTO langgraph.checkpoint_migrations (v) VALUES (1)",
            );
            return (
              await c.query("SELECT v FROM langgraph.checkpoint_migrations")
            ).rows;
          },
        );
        expect(worked).toEqual([{ v: 1 }]);

        // And the outgoing one still does, on the same table.
        await serving.query(
          "INSERT INTO langgraph.checkpoint_migrations (v) VALUES (2)",
        );
        expect(
          (
            await serving.query(
              "SELECT v FROM langgraph.checkpoint_migrations ORDER BY v",
            )
          ).rows,
        ).toEqual([{ v: 1 }, { v: 2 }]);
      } finally {
        await serving.end();
      }
    });

    test("a healthy re-boot does not lock the checkpointer's tables", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: the ordinary deploy — administrator and runtime role are different accounts, the
      // tables are the runtime role's — held against a reader's lock. `ALTER TABLE ... OWNER TO`
      // takes an ACCESS EXCLUSIVE lock even when the owner does not change, and this script runs on
      // EVERY boot, including the overlap where the previous container is still answering
      // customers. Either half of the transfer's filter keeps this case out of the loop, so no
      // single mutation shows up here; what it pins is that the common path never takes the lock,
      // however that comes about. Measured: 60ms as it stands, 2070ms with the filter gone
      // entirely, the latter being the lock_timeout deadline rather than a race.
      await onProbe(superuserOnProbe, async (c) => {
        await c.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
        await c.query(`CREATE SCHEMA langgraph AUTHORIZATION ${APP_ROLE}`);
        await c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)");
        await c.query(
          `ALTER TABLE langgraph.checkpoint_migrations OWNER TO ${APP_ROLE}`,
        );
      });

      const reader = new Client({
        connectionString: urlFor(APP_ROLE, ROTATED_PW, PROBE_DB),
      });
      await reader.connect();
      try {
        // ACCESS SHARE, held open: exactly what a live checkpointer is doing mid-deploy.
        await reader.query("BEGIN");
        await reader.query("SELECT v FROM langgraph.checkpoint_migrations");

        // NOTE: PGOPTIONS reaches the subprocess's own session, so an ALTER that queues behind the
        // reader fails in seconds instead of hanging the suite.
        const started = Date.now();
        const { exitCode } = await runBootstrap(ROTATED_PW, APP_ROLE, {
          PGOPTIONS: "-c lock_timeout=2000",
        });
        const elapsed = Date.now() - started;

        // NOTE: the wait is the assertion, not the exit code — a lock timeout inside the transfer
        // is caught and, on an install that needs no transfer, correctly swallowed, so a broken
        // loop still exits 0. What it cannot hide is having waited. The threshold sits an order of
        // magnitude above the healthy time and half the timeout below the broken one.
        expect(exitCode).toBe(0);
        expect(elapsed).toBeLessThan(1000);
      } finally {
        await reader.query("ROLLBACK").catch(() => {});
        await reader.end();
      }
    });

    test("one account doing both jobs does not lock its own tables either", async () => {
      const db = su as Client;
      const admin = new URL(suUrl as string);
      // NOTE: the case the `<> v_role` half of the filter exists for, and it is not hypothetical:
      // an install can point MIGRATION_DATABASE_URL and DATABASE_URL at the same account. Measured:
      // that install is STABLE rather than self-correcting — a role may not alter itself even with
      // CREATEROLE, so this script cannot strip its own privileges and the shape survives every
      // boot. The owner filter alone would then match every table (the account owns them all) and
      // re-own each one to itself, taking ACCESS EXCLUSIVE for no change, once per deploy.
      await db.query(
        `CREATE ROLE ${SOLO_ROLE} LOGIN PASSWORD '${APP_PW}' CREATEROLE NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(`CREATE DATABASE ${SOLO_DB} OWNER ${SOLO_ROLE}`);
      await onProbe(urlFor(admin.username, admin.password, SOLO_DB), (c) =>
        c.query("CREATE EXTENSION IF NOT EXISTS vector"),
      );

      const soloUrl = urlFor(SOLO_ROLE, APP_PW, SOLO_DB);
      const bootSolo = (extraEnv: Record<string, string> = {}) =>
        runBootstrap(APP_PW, SOLO_ROLE, {
          MIGRATION_DATABASE_URL: soloUrl,
          DATABASE_URL: soloUrl,
          ...extraEnv,
        });

      expect((await bootSolo()).exitCode).toBe(0);
      // What PostgresSaver.setup() does on that boot — as the runtime role, which here is also the
      // administrative one, so the tables land owned by `current_user`.
      await onProbe(soloUrl, (c) =>
        c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)"),
      );

      const reader = new Client({ connectionString: soloUrl });
      await reader.connect();
      try {
        await reader.query("BEGIN");
        await reader.query("SELECT v FROM langgraph.checkpoint_migrations");

        const started = Date.now();
        const { exitCode } = await bootSolo({
          PGOPTIONS: "-c lock_timeout=2000",
        });
        const elapsed = Date.now() - started;

        // Same threshold and same reasoning as the re-boot case above: the wait is the assertion.
        // Measured: 126ms as it stands, 2131ms with `<> v_role` dropped from the filter.
        expect(exitCode).toBe(0);
        expect(elapsed).toBeLessThan(1000);
      } finally {
        await reader.query("ROLLBACK").catch(() => {});
        await reader.end();
      }
    });

    test("half the tables reachable is not reachable", async () => {
      const db = su as Client;
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: `has_table_privilege` over a set has to be ALL of them, and the two ways to get that
      // wrong both look right on a one-table fixture: a comma-separated privilege list is OR rather
      // than AND, and aggregating with bool_or instead of bool_and passes a schema where a single
      // table is reachable. setup() touches every table it manages, so anything short of all of
      // them is a boot that dies partway. This owner is deliberately one the administrator has no
      // membership in, so bootstrap's own blanket GRANT cannot quietly repair the fixture.
      await db.query(`CREATE ROLE ${SPLIT_OWNER} NOLOGIN`);
      await onProbe(superuserOnProbe, async (c) => {
        await c.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
        await c.query(`CREATE SCHEMA langgraph AUTHORIZATION ${SPLIT_OWNER}`);
        await c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)");
        await c.query("CREATE TABLE langgraph.checkpoint_writes (v int)");
        for (const t of ["checkpoint_migrations", "checkpoint_writes"]) {
          await c.query(`ALTER TABLE langgraph.${t} OWNER TO ${SPLIT_OWNER}`);
        }
        await c.query(`GRANT USAGE, CREATE ON SCHEMA langgraph TO ${APP_ROLE}`);
        // Everything on the first table, nothing on the second.
        await c.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON langgraph.checkpoint_migrations TO ${APP_ROLE}`,
        );
      });

      const { exitCode, stdout, stderr } = await runBootstrap(
        ROTATED_PW,
        APP_ROLE,
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain("the tables already in it");
    });

    test("neither schema privilege stands in for the other", async () => {
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: the two schema privileges are checked as an AND, and this is the case that tells them
      // apart. Measured: with USAGE but not CREATE, `CREATE TABLE IF NOT EXISTS` is refused on the
      // schema even when the table already exists — Postgres checks the privilege before it checks
      // the IF NOT EXISTS — so setup() dies on its own migrations. A check that asked for USAGE
      // alone would report this install as fine.
      await onProbe(superuserOnProbe, async (c) => {
        await c.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
        await c.query(`CREATE SCHEMA langgraph AUTHORIZATION ${SPLIT_OWNER}`);
        await c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)");
        await c.query(
          `ALTER TABLE langgraph.checkpoint_migrations OWNER TO ${SPLIT_OWNER}`,
        );
        await c.query(`GRANT USAGE ON SCHEMA langgraph TO ${APP_ROLE}`);
        await c.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph TO ${APP_ROLE}`,
        );
      });

      const usageOnly = await runBootstrap(ROTATED_PW, APP_ROLE);
      const usageOutput = `${usageOnly.stdout}${usageOnly.stderr}`;
      expect(usageOnly.exitCode).toBe(1);
      expect(usageOutput).toContain("the schema itself");
      expect(usageOutput).not.toContain("the tables already in it");

      // NOTE: and the other way round, which is the half that hides: `has_table_privilege` does not
      // consider schema privileges at all, so a role holding CREATE but not USAGE reports every
      // table as reachable while being unable to name a single one of them. Dropping the USAGE
      // check would call this install healthy and let the server die on its first query.
      await onProbe(superuserOnProbe, async (c) => {
        await c.query(`REVOKE USAGE ON SCHEMA langgraph FROM ${APP_ROLE}`);
        await c.query(`GRANT CREATE ON SCHEMA langgraph TO ${APP_ROLE}`);
      });

      const createOnly = await runBootstrap(ROTATED_PW, APP_ROLE);
      expect(createOnly.exitCode).toBe(1);
      expect(`${createOnly.stdout}${createOnly.stderr}`).toContain(
        "the schema itself",
      );

      // The reason it is fatal, rather than something inferred from the privilege bits.
      await expect(
        onProbe(urlFor(APP_ROLE, ROTATED_PW, PROBE_DB), (c) =>
          c.query("SELECT v FROM langgraph.checkpoint_migrations"),
        ),
      ).rejects.toThrow("permission denied for schema langgraph");
    });

    test("a superuser administrator actually strips the attributes", async () => {
      const db = su as Client;
      const admin = new URL(suUrl as string);
      // NOTE: the refusal case above proves what a CREATEROLE administrator CANNOT do; nothing so
      // far proves the demotion works when it is allowed, so the DDL behind it went unmeasured —
      // an `ALTER ROLE` missing NOSUPERUSER or NOBYPASSRLS passed every test in this file. Only a
      // superuser can take those away, so only a superuser administrator exercises this path.
      await db.query(
        `CREATE ROLE ${PRIV_ROLE} LOGIN PASSWORD '${APP_PW}' SUPERUSER BYPASSRLS`,
      );

      const { exitCode, stdout, stderr } = await runBootstrap(
        APP_PW,
        PRIV_ROLE,
        {
          MIGRATION_DATABASE_URL: urlFor(
            admin.username,
            admin.password,
            PROBE_DB,
          ),
        },
      );
      expect(`${stdout}${stderr}`).not.toContain("makes RLS a no-op");
      expect(exitCode).toBe(0);

      // NOTE: to the catalog, because the catalog IS the effect here — RLS being enforced for this
      // role is exactly "these two columns are false", and the boot guard reads the same ones.
      const attrs = (
        await db.query(
          "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
          [PRIV_ROLE],
        )
      ).rows[0];
      expect(attrs).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
    });

    test("the account bootstrap adopts FROM may be serving too", async () => {
      const db = su as Client;
      const admin = new URL(suUrl as string);
      // NOTE: the mirror of the rotation case, and the one the owner filter cannot rule out on its
      // own: `current_user` is guaranteed not to be a RUNTIME role only if the install has one.
      // A brownfield install pointing both URLs at the privileged account is exactly the shape
      // #195 asks operators to correct, and during that correction the old container is still
      // serving as the migration account whose tables are about to be adopted.
      //
      // NOTE: what saves it is the membership bootstrap grants itself one step earlier — the
      // administrator inherits the incoming role, so it keeps reaching the tables it just handed
      // over. That inheritance must not be left to the cluster's configuration: an explicit GRANT
      // defaults `INHERIT` to the grantee's own `rolinherit`, so a NOINHERIT administrator gets
      // `inherit_option = false` and loses access the moment the transfer commits (measured). The
      // administrator here is NOINHERIT for that reason.
      await db.query(
        `CREATE ROLE ${NOINH_ADMIN} LOGIN PASSWORD '${ADMIN_PW}' CREATEROLE NOSUPERUSER NOBYPASSRLS NOINHERIT`,
      );
      await db.query(`CREATE DATABASE ${NOINH_DB} OWNER ${NOINH_ADMIN}`);
      await onProbe(urlFor(admin.username, admin.password, NOINH_DB), (c) =>
        c.query("CREATE EXTENSION IF NOT EXISTS vector"),
      );

      const adminUrl = urlFor(NOINH_ADMIN, ADMIN_PW, NOINH_DB);
      const boot = (appRole: string) =>
        runBootstrap(APP_PW, appRole, {
          MIGRATION_DATABASE_URL: adminUrl,
          DATABASE_URL: urlFor(appRole, APP_PW, NOINH_DB),
        });

      // The install as it stands: one privileged account doing both jobs.
      expect((await boot(NOINH_ADMIN)).exitCode).toBe(0);
      await onProbe(adminUrl, (c) =>
        c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)"),
      );

      // The old container, still answering on the privileged account across the correction.
      const serving = new Client({ connectionString: adminUrl });
      await serving.connect();
      try {
        expect((await boot(NOINH_APP)).exitCode).toBe(0);

        // The incoming role got what the transfer is for: it owns the table, so setup()'s own
        // migration can ALTER it.
        const worked = await onProbe(
          urlFor(NOINH_APP, APP_PW, NOINH_DB),
          async (c) => {
            await c.query(
              "INSERT INTO langgraph.checkpoint_migrations (v) VALUES (1)",
            );
            await c.query(
              "ALTER TABLE langgraph.checkpoint_migrations ALTER COLUMN v DROP NOT NULL",
            );
            return (
              await c.query("SELECT v FROM langgraph.checkpoint_migrations")
            ).rows;
          },
        );
        expect(worked).toEqual([{ v: 1 }]);

        // And the container that has not been drained yet still serves.
        await serving.query(
          "INSERT INTO langgraph.checkpoint_migrations (v) VALUES (2)",
        );
        expect(
          (
            await serving.query(
              "SELECT v FROM langgraph.checkpoint_migrations ORDER BY v",
            )
          ).rows,
        ).toEqual([{ v: 1 }, { v: 2 }]);
      } finally {
        await serving.end();
      }
    });

    test("a role that only INHERITS privilege is refused, like one that holds it", async () => {
      const db = su as Client;
      // NOTE: the attributes say safe and the role is not: it reaches BYPASSRLS through a
      // membership, which is precisely what the server's own `assertRuntimeRoleIsNotSuperuser`
      // refuses to start with. Bootstrap reading only the direct columns would provision it, report
      // success, and leave the server to crash-loop on a guard it had the catalog open to check —
      // and would first hand the administrative role an inherited path to that same privilege,
      // since the membership grant comes later.
      await db.query(`CREATE ROLE ${PRIV_PARENT} NOLOGIN BYPASSRLS`);
      await db.query(
        `CREATE ROLE ${HEIR_ROLE} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(`GRANT ${PRIV_PARENT} TO ${HEIR_ROLE}`);

      const { exitCode, stdout, stderr } = await runBootstrap(
        APP_PW,
        HEIR_ROLE,
      );
      const output = `${stdout}${stderr}`;
      expect(exitCode).toBe(1);
      expect(output).toContain(
        "reaches a privileged role through a membership",
      );
      // The operator needs the name of the role to revoke, not just the fact.
      expect(output).toContain(PRIV_PARENT);
      expect(output).toContain("REVOKE");

      // NOTE: and it refuses BEFORE granting, which is the half that matters for the live account:
      // the membership bootstrap gives itself carries INHERIT TRUE, so granting first would hand
      // the administrative role the very privilege this refusal is about.
      expect(
        (
          await db.query(
            `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
              WHERE r.rolname = $1`,
            [HEIR_ROLE],
          )
        ).rowCount,
      ).toBe(0);

      // NOTE: SUPERUSER on its own reaches the same refusal. BYPASSRLS alone was the fixture, and
      // a check narrowed to it would pass a role that inherits the whole server.
      await db.query(`REVOKE ${PRIV_PARENT} FROM ${HEIR_ROLE}`);
      await db.query(`CREATE ROLE ${SU_PARENT} NOLOGIN SUPERUSER NOBYPASSRLS`);
      await db.query(`GRANT ${SU_PARENT} TO ${HEIR_ROLE}`);
      const viaSuperuser = await runBootstrap(APP_PW, HEIR_ROLE);
      expect(viaSuperuser.exitCode).toBe(1);
      expect(`${viaSuperuser.stdout}${viaSuperuser.stderr}`).toContain(
        SU_PARENT,
      );

      // NOTE: a transitive membership is the case the message has to get right. `heir -> team ->
      // privileged` reaches the privileged role, but `REVOKE <privileged> FROM heir` names a grant
      // that does not exist — and Postgres ACCEPTS it as a no-op (measured), so the operator runs
      // it, sees success, restarts, and fails identically. The statement has to name the edge.
      await db.query(`REVOKE ${SU_PARENT} FROM ${HEIR_ROLE}`);
      await db.query(`CREATE ROLE ${TEAM_ROLE} NOLOGIN`);
      await db.query(`GRANT ${SU_PARENT} TO ${TEAM_ROLE}`);
      await db.query(`GRANT ${TEAM_ROLE} TO ${HEIR_ROLE}`);
      // NOTE: and a second path to the same privilege that the role does NOT inherit. It is not
      // why the boot fails, so revoking it would cost the operator a membership for nothing — the
      // suggestion has to leave it out even though it reaches the same place.
      await db.query(`CREATE ROLE ${SIDE_ROLE} NOLOGIN`);
      await db.query(`GRANT ${SU_PARENT} TO ${SIDE_ROLE}`);
      await db.query(
        `GRANT ${SIDE_ROLE} TO ${HEIR_ROLE} WITH INHERIT FALSE, SET FALSE`,
      );

      const transitive = await runBootstrap(APP_PW, HEIR_ROLE);
      const via = `${transitive.stdout}${transitive.stderr}`;
      expect(transitive.exitCode).toBe(1);
      expect(via).toContain(`(${SU_PARENT})`);
      expect(via).toContain(`REVOKE ${TEAM_ROLE} FROM "${HEIR_ROLE}"`);
      expect(via).not.toContain(`REVOKE ${SU_PARENT}`);
      expect(via).not.toContain(SIDE_ROLE);

      // NOTE: and a membership that does NOT inherit is accepted, which fixes the choice rather
      // than leaving it to look like an oversight. The question asked is `pg_has_role(..., 'USAGE')`
      // — the boot guard's own — so bootstrap refuses exactly what the server refuses and no more.
      // A stricter 'MEMBER' would reject an install the server starts on: measured, it is true of
      // every membership, including the two that cannot escalate.
      //
      // NOTE: what neither question actually measures, for whoever revisits this or the guard.
      // SUPERUSER and BYPASSRLS are role ATTRIBUTES, and attributes are not inherited through a
      // membership — only object privileges are. Measured against a table under RLS: a role
      // inheriting a BYPASSRLS role still sees one row, and sees two only after `SET ROLE` to it.
      // So escalation needs `set_option`, not inheritance, and both checks are aimed slightly off:
      // on PostgreSQL's defaults (an INHERIT role, a plain GRANT) the two coincide and the answer
      // is right, which is why this holds. They diverge on a NOINHERIT runtime role, where a plain
      // GRANT lands `inherit_option false, set_option true` and escalates unseen. Deliberately not
      // changed here: `set_option` is 16-only, the real predicate is transitive, and tightening it
      // would refuse installs that boot today — that is its own change, in `src/lib/db-guard.ts`,
      // not a line to sneak into this one.
      await db.query(`REVOKE ${TEAM_ROLE} FROM ${HEIR_ROLE}`);
      await db.query(`REVOKE ${SIDE_ROLE} FROM ${HEIR_ROLE}`);
      await db.query(
        `GRANT ${SU_PARENT} TO ${HEIR_ROLE} WITH INHERIT FALSE, SET FALSE`,
      );
      // The earlier cases left `langgraph` under an owner this role cannot reach, which would fail
      // the boot for an unrelated reason and hide the one being measured.
      await onProbe(
        urlFor(
          new URL(suUrl as string).username,
          new URL(suUrl as string).password,
          PROBE_DB,
        ),
        (c) => c.query("DROP SCHEMA IF EXISTS langgraph CASCADE"),
      );
      const notInherited = await runBootstrap(APP_PW, HEIR_ROLE);
      expect(`${notInherited.stdout}${notInherited.stderr}`).not.toContain(
        "reaches a privileged role",
      );
      expect(notInherited.exitCode).toBe(0);
    });

    test("a membership that cannot inherit does not get the tables moved under it", async () => {
      const db = su as Client;
      const admin = new URL(suUrl as string);
      const superuserOnProbe = urlFor(admin.username, admin.password, PROBE_DB);
      // NOTE: `ALTER TABLE ... OWNER TO` needs MEMBERSHIP in the new owner; keeping access to the
      // table afterwards needs to INHERIT it. A membership granted `SET TRUE, INHERIT FALSE` has
      // the first and not the second, and bootstrap's own grant cannot repair it without ADMIN on
      // the role — the GRANT fails, is warned about, and the transfer would still go through,
      // leaving the administrator with `permission denied` on the table it just handed over
      // (measured). So the transfer asks for inheritance, not for membership.
      await db.query(
        `CREATE ROLE ${SETONLY_ROLE} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(
        `GRANT CONNECT ON DATABASE ${PROBE_DB} TO ${SETONLY_ROLE}`,
      );
      // Granted by the superuser, so the administrator holds no ADMIN and cannot re-grant it.
      await db.query(
        `GRANT ${SETONLY_ROLE} TO ${ADMIN_ROLE} WITH SET TRUE, INHERIT FALSE`,
      );
      await onProbe(superuserOnProbe, async (c) => {
        await c.query("DROP SCHEMA IF EXISTS langgraph CASCADE");
        await c.query(`CREATE SCHEMA langgraph AUTHORIZATION ${ADMIN_ROLE}`);
      });
      await onProbe(urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB), (c) =>
        c.query("CREATE TABLE langgraph.checkpoint_migrations (v int)"),
      );

      const { exitCode, stdout, stderr } = await runBootstrap(
        APP_PW,
        SETONLY_ROLE,
      );
      expect(exitCode).toBe(0);
      expect(`${stdout}${stderr}`).toContain("does not own");

      // The tables stayed put, so the account that may still be serving on them can still read.
      const state = await onProbe(
        urlFor(ADMIN_ROLE, ADMIN_PW, PROBE_DB),
        async (c) => {
          await c.query(
            "INSERT INTO langgraph.checkpoint_migrations (v) VALUES (1)",
          );
          return (
            await c.query(
              "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'langgraph.checkpoint_migrations'::regclass",
            )
          ).rows[0];
        },
      );
      expect(state).toEqual({ owner: ADMIN_ROLE });

      // And the incoming role is carried by the grants regardless, which is the fallback.
      const worked = await onProbe(
        urlFor(SETONLY_ROLE, APP_PW, PROBE_DB),
        async (c) => {
          await c.query(
            "INSERT INTO langgraph.checkpoint_migrations (v) VALUES (2)",
          );
          return (
            await c.query(
              "SELECT v FROM langgraph.checkpoint_migrations ORDER BY v",
            )
          ).rows;
        },
      );
      expect(worked).toEqual([{ v: 1 }, { v: 2 }]);
    });
  },
);
