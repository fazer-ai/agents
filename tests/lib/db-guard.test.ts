import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  assertRuntimeRoleIsNotSuperuser,
  FLEET_INHERITED_REASON,
  SuperuserRuntimeError,
} from "@/lib/db-guard";
import { FLEET_ROLE } from "@/lib/tenancy/fleet-role";

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
  describe(`membership in ${FLEET_ROLE}`, () => {
    test("SET ROLE is fine; INHERITING it is refused, and the message says which GRANT repairs it", async () => {
      await withRoleCatalogLock(async (db) => {
        await db.$executeRawUnsafe(
          `GRANT ${FLEET_ROLE} TO ${SAFE_ROLE} WITH INHERIT FALSE, SET TRUE`,
        );
      });
      await expect(
        assertRuntimeRoleIsNotSuperuser(tmp as PrismaClient),
      ).resolves.toBeUndefined();

      await withRoleCatalogLock(async (db) => {
        await db.$executeRawUnsafe(
          `GRANT ${FLEET_ROLE} TO ${SAFE_ROLE} WITH INHERIT TRUE`,
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
        await db.$executeRawUnsafe(`REVOKE ${FLEET_ROLE} FROM ${SAFE_ROLE}`);
      });
    });
  });
});

function dbName(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}
