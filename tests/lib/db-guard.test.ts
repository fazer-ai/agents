import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  assertRuntimeRoleIsNotSuperuser,
  FLEET_INHERITED_REASON,
  FleetPolicyMismatchError,
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
      // The shape a restore leaves behind: the function resolves THIS database's name (a role that
      // does not exist here), while the policy carries the role of the database it was dumped from.
      await onProbeRaw(`
        CREATE OR REPLACE FUNCTION public.fazerai_fleet_role()
          RETURNS name LANGUAGE sql STABLE AS $fn$
            SELECT ('fazerai_fleet_'
                    || left(current_database()::text, 30)
                    || '_' || substr(md5(current_database()::text), 1, 8))::name
          $fn$;
        CREATE TABLE t (id bigserial PRIMARY KEY, tenant_id bigint NOT NULL);
        ALTER TABLE t ENABLE ROW LEVEL SECURITY;
        CREATE POLICY tenant_isolation ON t
          USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
        CREATE POLICY fleet_super_admin ON t TO CURRENT_USER USING (true);`);
    });

    afterAll(async () => {
      await probe?.$disconnect();
      await suDb.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`,
      );
    });

    test("refuses, and names the rename that repairs it", async () => {
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
      expect(err?.message).toContain(`fazerai_fleet_${PROBE_DB.slice(0, 30)}`);
      expect(err?.message).toContain("fleet_super_admin on t");
      expect(err?.message).toContain("RENAME TO");
    });

    test("and passes once the resolved name is the one the policy carries", async () => {
      // The repair, expressed from the other end: renaming the role the policies name IS what makes
      // the resolved name match, and here that is done by resolving to the role already named.
      await onProbeRaw(`
        CREATE OR REPLACE FUNCTION public.fazerai_fleet_role()
          RETURNS name LANGUAGE sql STABLE AS $fn$ SELECT current_user::name $fn$;`);
      await expect(
        assertRuntimeRoleIsNotSuperuser(probe as PrismaClient, { allow: true }),
      ).resolves.toBeUndefined();
    });
  },
);

function dbName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}
