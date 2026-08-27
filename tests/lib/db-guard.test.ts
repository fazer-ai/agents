import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import * as dbGuard from "@/lib/db-guard";
import {
  assertRuntimeRoleIsNotSuperuser,
  FLEET_INHERITED_REASON,
  FleetPolicyMismatchError,
  FleetRoleUnreachableError,
  RuntimeIsolationError,
  SuperuserRuntimeError,
} from "@/lib/db-guard";
import { FLEET_ROLE_FN } from "@/lib/tenancy/fleet-role";

// MIGRATION_DATABASE_URL connects as the Postgres superuser (the migration/owner role).
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

const SAFE_ROLE = `fazerai_guard_safe_${process.pid}`;
let tmp: PrismaClient | undefined;

// NOTE: roles and database grants live in CLUSTER-WIDE catalogs (pg_authid, pg_database), which
// Postgres does not serialize for concurrent DDL — two suites running at once against the same
// server hit `XX000: tuple concurrently updated` even though each uses its own pid-suffixed role.
// The role name keeps them from clashing logically; this advisory lock keeps them from clashing
// physically, by making each run take its turn through the catalog writes.
async function withRoleCatalogLock(
  statements: (db: PrismaClient) => Promise<void>,
): Promise<void> {
  await suDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729104553)`;
    await statements(tx as unknown as PrismaClient);
  });
}

// Needs no database, and that is the point: it is about the SHAPE of the refusals rather than about
// any one of them. `src/index.ts` rethrows on the base class, so a refusal that does not extend it
// is caught there as "DB unavailable?" and the process keeps serving — which is exactly what
// happened when `FleetPolicyMismatchError` was added and the boot path still named only
// `SuperuserRuntimeError`.
describe("every refusal this guard makes is fatal at boot", () => {
  test("all of them extend the class src/index.ts rethrows on", () => {
    const errorClasses = Object.entries(dbGuard).filter(
      ([, v]) =>
        typeof v === "function" &&
        v !== RuntimeIsolationError &&
        Object.prototype.isPrototypeOf.call(Error, v),
    );
    // Positive control: a scan that matched nothing would pass whatever the answer is.
    expect(errorClasses.map(([k]) => k).sort()).toEqual([
      "FleetPolicyMismatchError",
      "FleetRoleUnreachableError",
      "SuperuserRuntimeError",
    ]);
    for (const [, cls] of errorClasses) {
      expect(
        Object.prototype.isPrototypeOf.call(RuntimeIsolationError, cls),
      ).toBe(true);
    }
  });

  test("and src/index.ts catches the base, not one of them by name", async () => {
    const source = await Bun.file(
      new URL("../../src/index.ts", import.meta.url).pathname,
    ).text();
    const code = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).toContain("error instanceof RuntimeIsolationError");
    expect(code).not.toContain("error instanceof SuperuserRuntimeError");
  });
});

describe.skipIf(!dbUp)("assertRuntimeRoleIsNotSuperuser", () => {
  beforeAll(async () => {
    // A throwaway NON-superuser, NON-bypassrls role to prove the safe path. Built from the su URL
    // with the credentials swapped.
    await withRoleCatalogLock(async (db) => {
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${SAFE_ROLE}`);
      await db.$executeRawUnsafe(
        `CREATE ROLE ${SAFE_ROLE} LOGIN PASSWORD 'guardpw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await db.$executeRawUnsafe(
        `GRANT CONNECT ON DATABASE "${dbName(suUrl as string)}" TO ${SAFE_ROLE}`,
      );
      // A runtime role that cannot SET ROLE into the fleet role is REFUSED now, so a fixture
      // standing for "a healthy runtime role" has to be one — the state this grant creates is
      // exactly what `db-bootstrap` provisions.
      const fleet = (
        (await db.$queryRawUnsafe(`SELECT ${FLEET_ROLE_FN} AS role`)) as Array<{
          role: string;
        }>
      )[0]?.role as string;
      await db.$executeRawUnsafe(
        `GRANT "${fleet}" TO ${SAFE_ROLE} WITH INHERIT FALSE, SET TRUE`,
      );
    });
    const tmpUrl = (suUrl as string).replace(
      /\/\/[^@]+@/,
      `//${SAFE_ROLE}:guardpw@`,
    );
    tmp = new PrismaClient({
      adapter: new PrismaPg({ connectionString: tmpUrl }),
    });
    await tmp.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    if (tmp) await tmp.$disconnect();
    await withRoleCatalogLock(async (db) => {
      await db.$executeRawUnsafe(
        `REVOKE ALL ON DATABASE "${dbName(suUrl as string)}" FROM ${SAFE_ROLE}`,
      );
      // Every privilege it accumulated in THIS database — the fleet-role membership and the EXECUTE
      // grant the tests above hand it — or the DROP below answers `2BP01`, "cannot be dropped
      // because some objects depend on it".
      await db.$executeRawUnsafe(`DROP OWNED BY ${SAFE_ROLE} CASCADE`);
      await db.$executeRawUnsafe(`DROP ROLE IF EXISTS ${SAFE_ROLE}`);
    });
    await suDb.$disconnect();
  });

  test("throws for a superuser runtime role (RLS would be a no-op)", async () => {
    expect(assertRuntimeRoleIsNotSuperuser(suDb)).rejects.toBeInstanceOf(
      SuperuserRuntimeError,
    );
  });

  test("ALLOW_SUPERUSER_RUNTIME opt-in downgrades to a warning, no throw", async () => {
    await expect(
      assertRuntimeRoleIsNotSuperuser(suDb, { allow: true }),
    ).resolves.toBeUndefined();
  });

  test("passes for a non-superuser, non-bypassrls role", async () => {
    await expect(
      assertRuntimeRoleIsNotSuperuser(tmp as PrismaClient),
    ).resolves.toBeUndefined();
  });

  // The membership that makes the cross-tenant path possible is the same one that can delete the
  // isolation, and the difference between the two is one word in the GRANT. Neither attribute
  // changes, so the check above sees nothing: the role stays NOSUPERUSER and NOBYPASSRLS through
  // both arms below, and only `pg_has_role(..., 'USAGE')` moves.
  describe("membership in the fleet role", () => {
    // NOTE: the same refusal reached the other way. Without EXECUTE on the resolver every
    // cross-tenant statement dies on the function call — and before this, the guard itself threw a
    // raw driver error that the boot path read as "DB unavailable?" and warned past, so the process
    // served with its front door shut. Asked of the catalog, so the guard never makes the call it
    // is checking.
    test("no EXECUTE on the resolver is refused, not read as an outage", async () => {
      await suDb.$executeRawUnsafe(
        `REVOKE EXECUTE ON FUNCTION ${FLEET_ROLE_FN} FROM PUBLIC`,
      );
      try {
        const err = await assertRuntimeRoleIsNotSuperuser(tmp as PrismaClient, {
          allow: true,
        }).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err).toBeInstanceOf(FleetRoleUnreachableError);
        expect(err?.message).toContain("GRANT EXECUTE ON FUNCTION");
        // The repair, run, and the guard passes again.
        await suDb.$executeRawUnsafe(
          `GRANT EXECUTE ON FUNCTION ${FLEET_ROLE_FN} TO ${SAFE_ROLE}`,
        );
        await expect(
          assertRuntimeRoleIsNotSuperuser(tmp as PrismaClient, { allow: true }),
        ).resolves.toBeUndefined();
      } finally {
        await suDb.$executeRawUnsafe(
          `GRANT EXECUTE ON FUNCTION ${FLEET_ROLE_FN} TO PUBLIC`,
        );
      }
    });

    // NOTE: refused BEFORE the ALLOW_SUPERUSER_RUNTIME branch, and `allow: true` is passed to prove
    // it. That flag says "I accept that RLS may be a no-op on this connection" — a statement about
    // isolation. Not being able to enter the fleet role is a different thing: the process would
    // start and fail every authenticated request, because that is how an API key is verified.
    test("a runtime that cannot enter the fleet role is refused, flag or no flag", async () => {
      const fleetRole = (
        (await suDb.$queryRawUnsafe(
          `SELECT ${FLEET_ROLE_FN} AS role`,
        )) as Array<{ role: string }>
      )[0]?.role as string;
      await withRoleCatalogLock(async (db) => {
        await db.$executeRawUnsafe(`REVOKE "${fleetRole}" FROM ${SAFE_ROLE}`);
      });
      const err = await assertRuntimeRoleIsNotSuperuser(tmp as PrismaClient, {
        allow: true,
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(FleetRoleUnreachableError);
      expect(err?.message).toContain("API key");
      expect(err?.message).toContain("WITH INHERIT FALSE, SET TRUE;");
      await withRoleCatalogLock(async (db) => {
        await db.$executeRawUnsafe(
          `GRANT "${fleetRole}" TO ${SAFE_ROLE} WITH INHERIT FALSE, SET TRUE`,
        );
      });
    });

    test("SET ROLE is fine; INHERITING it is refused, and the message says which GRANT repairs it", async () => {
      // Resolved from the database: the name carries the database (see `@/lib/tenancy/fleet-role`),
      // so writing it here would be a second spelling of the thing under test.
      const fleetRole = (
        (await suDb.$queryRawUnsafe(
          `SELECT ${FLEET_ROLE_FN} AS role`,
        )) as Array<{ role: string }>
      )[0]?.role as string;
      await withRoleCatalogLock(async (db) => {
        await db.$executeRawUnsafe(
          `GRANT "${fleetRole}" TO ${SAFE_ROLE} WITH INHERIT FALSE, SET TRUE`,
        );
      });
      await expect(
        assertRuntimeRoleIsNotSuperuser(tmp as PrismaClient),
      ).resolves.toBeUndefined();

      await withRoleCatalogLock(async (db) => {
        await db.$executeRawUnsafe(
          `GRANT "${fleetRole}" TO ${SAFE_ROLE} WITH INHERIT TRUE`,
        );
      });
      const err = await assertRuntimeRoleIsNotSuperuser(
        tmp as PrismaClient,
      ).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(SuperuserRuntimeError);
      expect(err?.message).toContain(FLEET_INHERITED_REASON);
      expect(err?.message).toContain("WITH INHERIT FALSE, SET TRUE");

      // The role never became privileged in the pg_roles sense — which is the whole point of asking
      // this separately.
      const attrs = (await (tmp as PrismaClient).$queryRawUnsafe(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      )) as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;
      expect(attrs[0]).toEqual({ rolsuper: false, rolbypassrls: false });

      await withRoleCatalogLock(async (db) => {
        await db.$executeRawUnsafe(`REVOKE "${fleetRole}" FROM ${SAFE_ROLE}`);
      });
    });
  });
});

// The fleet role's name carries the database, so a database RESTORED under a different name resolves
// a name its own dumped policies do not mention — and nothing errors: SET ROLE succeeds and every
// fleet read then matches no policy and answers zero rows. This is the one failure this guard exists
// for that has no symptom of its own, so it gets a database of its own rather than a probe on the
// shared one: a misnamed policy sitting in the suite's database, even briefly, is exactly what the
// catalog fence in rls-policy-shape.test.ts would trip over.
// The fleet role's name carries the database, so a database RESTORED under a different name resolves
// a name its own dumped policies do not mention — and nothing errors: SET ROLE succeeds and every
// fleet read then matches no policy and answers zero rows. This is the one failure this guard exists
// for that has no symptom of its own, so it gets a database of its own rather than a probe on the
// shared one: a misnamed policy sitting in the suite's database, even briefly, is exactly what the
// catalog fence in rls-policy-shape.test.ts would trip over.
//
// And it creates no ROLE. Role DDL is cluster-wide and serialized here through an advisory lock that
// db-bootstrap.test.ts holds at SESSION level for its whole suite — measured, taking it from this
// file cost four 5-second timeouts in a full run. The mismatch is expressible without it: the policy
// names a role that certainly exists and is not the resolved one, and the "repaired" arm redefines
// the function to return that same role.
describe.skipIf(!dbUp)(
  "a database whose fleet policies name another role",
  () => {
    const PROBE_DB = `fazerai_guard_restore_${process.pid}`;
    let probe: PrismaClient | undefined;
    let probeUrl = "";

    async function onProbeRaw(sql: string) {
      const raw = new Client({ connectionString: probeUrl });
      await raw.connect();
      try {
        await raw.query(sql);
      } finally {
        await raw.end();
      }
    }

    beforeAll(async () => {
      await suDb.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`,
      );
      await suDb.$executeRawUnsafe(`CREATE DATABASE ${PROBE_DB}`);
      const url = new URL(suUrl as string);
      url.pathname = `/${PROBE_DB}`;
      probeUrl = url.toString();
      probe = new PrismaClient({
        adapter: new PrismaPg({ connectionString: probeUrl }),
      });
      // The shape a restore leaves behind: the function resolves one name while the policies carry
      // another. It resolves to `pg_monitor` — a built-in role, so this needs no role DDL, which
      // matters: role DDL is cluster-wide and serialized here through an advisory lock that
      // db-bootstrap.test.ts holds at SESSION level for its whole suite (measured, taking it from
      // this file cost four 5-second timeouts in a full run). What the guard compares is a name
      // against what the policies name, and that is the same comparison either way.
      //
      // TWO tables, because the repair has to reach all of them: one that fixes the table the
      // message happened to list first is the same silent zero-row read on the one it missed.
      await onProbeRaw(`
        CREATE OR REPLACE FUNCTION public.fazerai_fleet_role()
          RETURNS name LANGUAGE sql STABLE AS $fn$ SELECT 'pg_monitor'::name $fn$;
        CREATE TABLE t (id bigserial PRIMARY KEY, tenant_id bigint NOT NULL);
        CREATE TABLE u (id bigserial PRIMARY KEY, tenant_id bigint NOT NULL);
        ALTER TABLE t ENABLE ROW LEVEL SECURITY;
        ALTER TABLE u ENABLE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON t
          USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
        CREATE POLICY fleet_super_admin ON t TO CURRENT_USER USING (true);
        CREATE POLICY fleet_super_admin ON u TO CURRENT_USER USING (true);`);
    });

    afterAll(async () => {
      await probe?.$disconnect();
      await suDb.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`,
      );
    });

    test("refuses, and lists every table whose policy is misnamed", async () => {
      // `allow: true` on purpose: this refusal is NOT what ALLOW_SUPERUSER_RUNTIME covers. That flag
      // means "I accept that RLS may be a no-op here"; this is the cross-tenant path reading nothing
      // at all, which no flag should wave through.
      const err = await assertRuntimeRoleIsNotSuperuser(probe as PrismaClient, {
        allow: true,
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(FleetPolicyMismatchError);
      expect(err?.message).toContain('do not name "pg_monitor"');
      // Every offender, not just the first: a repair that fixes one table and leaves the next is
      // the same silent zero-row read on the table it missed.
      expect(err?.message).toContain("fleet_super_admin on t");
      expect(err?.message).toContain("fleet_super_admin on u");
    });

    // Containment is not the question, EXACTNESS is: a policy is a role LIST, and `USING (true)`
    // applies to every name on it. `tests/lib/rls-policy-shape.test.ts` measures what that costs —
    // an ordinary runtime connection reading all 3200 rows with no scope and no `SET ROLE`. Here
    // the question is only whether the guard sees it, which it did not while it asked `= ANY`.
    //
    // Built-in roles on both sides, so this needs no role DDL: see the beforeAll for why that
    // matters in this file.
    test("an EXTRA role on an otherwise correct policy is refused too", async () => {
      await onProbeRaw(`
        DROP POLICY fleet_super_admin ON t;
        DROP POLICY fleet_super_admin ON u;
        CREATE POLICY fleet_super_admin ON t TO pg_monitor USING (true);
        CREATE POLICY fleet_super_admin ON u TO pg_monitor, pg_read_all_stats USING (true);`);
      const err = await assertRuntimeRoleIsNotSuperuser(probe as PrismaClient, {
        allow: true,
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(FleetPolicyMismatchError);
      // Only the one carrying the extra name: a check that flagged both would pass this assertion
      // by flagging everything, which is the failure mode on the other side of exactness.
      expect(err?.message).toContain("fleet_super_admin on u");
      expect(err?.message).not.toContain("fleet_super_admin on t");
    });

    // `TO PUBLIC, <fleet>` was already caught before this change, and by a different mechanism:
    // PostgreSQL collapses that list to the single OID 0, which is no role's, so the old
    // containment check missed the fleet role and fired. Kept as its own arm because the two now
    // pass for the same reason and a future simplification could lose one of them.
    test("PUBLIC alongside the fleet role is refused, however it is spelled", async () => {
      await onProbeRaw(`
        DROP POLICY fleet_super_admin ON t;
        DROP POLICY fleet_super_admin ON u;
        CREATE POLICY fleet_super_admin ON t TO pg_monitor USING (true);
        CREATE POLICY fleet_super_admin ON u TO PUBLIC, pg_monitor USING (true);`);
      const err = await assertRuntimeRoleIsNotSuperuser(probe as PrismaClient, {
        allow: true,
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(FleetPolicyMismatchError);
      expect(err?.message).toContain("fleet_super_admin on u");
    });

    // The repair is run VERBATIM out of the message the guard produced, which is the only way to
    // know it is runnable at all. The previous spelling of this message named a rename that could
    // never work in the order this fires: bootstrap runs before the guard and has already created
    // the resolved role, so `ALTER ROLE … RENAME TO` fails on a name that is taken.
    test("and the repair the message prints actually repairs it", async () => {
      const err = (await assertRuntimeRoleIsNotSuperuser(
        probe as PrismaClient,
        {
          allow: true,
        },
      ).then(
        () => null,
        (e: unknown) => e as Error,
      )) as Error;
      const repair = err.message.slice(err.message.indexOf("DO $$"));
      expect(repair).toStartWith("DO $$");
      await onProbeRaw(repair);
      await expect(
        assertRuntimeRoleIsNotSuperuser(probe as PrismaClient, { allow: true }),
      ).resolves.toBeUndefined();

      // And it landed on BOTH tables, not on the one the message happened to list first.
      const named = new Client({ connectionString: probeUrl });
      await named.connect();
      try {
        const rows = (
          await named.query<{ relname: string; roles: string }>(`
            SELECT c.relname,
                   (SELECT string_agg(r.rolname, ',') FROM pg_roles r
                     WHERE r.oid = ANY (p.polroles)) AS roles
              FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
             WHERE p.polname = 'fleet_super_admin' ORDER BY 1`)
        ).rows;
        expect(rows.map((r) => `${r.relname}:${r.roles}`)).toEqual([
          "t:pg_monitor",
          "u:pg_monitor",
        ]);
      } finally {
        await named.end();
      }
    });
  },
);

function dbName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}
