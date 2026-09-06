import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  deleteUser,
  LastAdminError,
  updateUserRole,
} from "@/api/features/admin/admin.service";
import type { TenantContext } from "@/lib/tenancy";
import { waitUntilBlocked } from "@/tests/utils/pg-waits";

// The invariant is "a scope keeps somebody who can administer it", and #496 is about WHERE it is
// enforced: `deleteUser` refuses to remove the last admin, `updateUserRole` demotes them with no
// guard at all, and the count the delete does read is not serialised against another delete aimed
// at a DIFFERENT admin of the same scope.
//
// Every test here scopes itself to a tenant created for it. The fleet half of the same invariant
// (the last SUPER_ADMIN, tenantId null) is deliberately NOT asserted by counting: `users` is global,
// the suite runs against a database other files write to, and a count keyed on a scope everyone
// shares measures the neighbour rather than the rule.
const actor = (tenantId: bigint | null, userId: bigint): TenantContext => ({
  tenantId,
  userId,
  role: tenantId === null ? "SUPER_ADMIN" : "TENANT_ADMIN",
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

describe.skipIf(!dbUp)("a scope keeps an administrator", () => {
  const tenants: bigint[] = [];
  let seq = 0;

  // A tenant of its own per test, because the count the guard reads is over the scope: two tests
  // sharing a tenant would each be measuring the other's admins.
  async function scope(admins: number, agents = 0) {
    seq += 1;
    const t = await suDb.tenant.create({
      data: { name: `LA${seq}`, slug: `la-${process.pid}-${seq}` },
    });
    tenants.push(t.id);
    const mk = async (role: "TENANT_ADMIN" | "AGENT", n: number) =>
      (
        await suDb.user.create({
          data: {
            tenantId: t.id,
            email: `la-${process.pid}-${seq}-${role}-${n}@x.test`,
            role,
            passwordHash: "x",
          },
          select: { id: true },
        })
      ).id;
    const adminIds: bigint[] = [];
    for (let i = 0; i < admins; i += 1)
      adminIds.push(await mk("TENANT_ADMIN", i));
    const agentIds: bigint[] = [];
    for (let i = 0; i < agents; i += 1) agentIds.push(await mk("AGENT", i));
    return { tenantId: t.id, adminIds, agentIds };
  }

  // Fleet administrators belong to no tenant, so they are tracked by id and cleaned up by id.
  const fleetIds: bigint[] = [];
  async function fleetAdmin(n: number): Promise<bigint> {
    const row = await suDb.user.create({
      data: {
        tenantId: null,
        email: `la-fleet-${process.pid}-${n}@x.test`,
        role: "SUPER_ADMIN",
        passwordHash: "x",
      },
      select: { id: true },
    });
    fleetIds.push(row.id);
    return row.id;
  }

  const adminsOf = (tenantId: bigint) =>
    suDb.user.count({ where: { tenantId, role: "TENANT_ADMIN" } });

  interface Holder {
    pid: number;
    release: () => void;
    done: Promise<void>;
  }

  // Holds `FOR UPDATE` on the rows the two writers are going to want, and resolves once it HAS them.
  // Its own connection, so parking it cannot starve the pool the writers run on.
  async function holdRows(ids: bigint[]): Promise<Holder> {
    const conn = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl as string }),
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ready!: (pid: number) => void;
    const got = new Promise<number>((r) => {
      ready = r;
    });
    const done = conn
      .$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT id FROM users WHERE id IN (${ids.join(",")}) ORDER BY id FOR UPDATE`,
          );
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid()::int AS pid`;
          ready(row?.pid ?? 0);
          await gate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
      .then(() => conn.$disconnect());
    return { pid: await got, release, done };
  }

  afterAll(async () => {
    if (fleetIds.length > 0) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM users WHERE id IN (${fleetIds.join(",")})`,
      );
    }
    if (tenants.length > 0) {
      const list = tenants.join(",");
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id IN (${list})`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM users WHERE tenant_id IN (${list})`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN (${list})`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // The half the issue is titled after: the same invariant the delete enforces, on the write that
  // reduces the count without removing anybody.
  test("demoting the last administrator of a tenant is refused", async () => {
    const { tenantId, adminIds } = await scope(1);
    await expect(
      updateUserRole(
        actor(null, 999_999n),
        adminIds[0] as bigint,
        { role: "AGENT" },
        appDb,
      ),
    ).rejects.toBeInstanceOf(LastAdminError);
    expect(await adminsOf(tenantId)).toBe(1);
  });

  // The control in the same shape: with somebody else holding the scope, the demote goes through.
  test("demoting one of two administrators is allowed", async () => {
    const { tenantId, adminIds } = await scope(2);
    const after = await updateUserRole(
      actor(null, 999_999n),
      adminIds[0] as bigint,
      { role: "AGENT" },
      appDb,
    );
    expect(after.role).toBe("AGENT");
    expect(await adminsOf(tenantId)).toBe(1);
  });

  // A demote of somebody who is not an administrator has nothing to do with the invariant, and must
  // not start refusing (or waiting) because of it.
  test("re-roling a regular user is untouched by the guard", async () => {
    const { tenantId, agentIds } = await scope(1, 1);
    const after = await updateUserRole(
      actor(null, 999_999n),
      agentIds[0] as bigint,
      { role: "TENANT_ADMIN" },
      appDb,
    );
    expect(after.role).toBe("TENANT_ADMIN");
    expect(await adminsOf(tenantId)).toBe(2);
  });

  // The fleet is the other scope the invariant answers for, and it is asserted only in the direction
  // a shared database can answer: with two fleet administrators seeded here, removing one is allowed.
  // The opposite claim (the LAST one is refused) would have to count a scope every other suite writes
  // to, so it is left to the tenant tests above, which own their scope.
  //
  // What this pins is the scope predicate: the fleet's rows have `tenant_id IS NULL`, and a guard
  // written with `=` instead of `IS NOT DISTINCT FROM` matches nothing there, so it reads an empty
  // set and refuses every fleet removal.
  test("removing one of two fleet administrators is allowed", async () => {
    const keep = await fleetAdmin(1);
    const goes = await fleetAdmin(2);
    await deleteUser(actor(null, keep), goes, appDb);
    expect(await suDb.user.count({ where: { id: goes } })).toBe(0);
    expect(await suDb.user.count({ where: { id: keep } })).toBe(1);
  });

  // The one property with no behavioural test, pinned on the source instead of left unsaid: the
  // scope is locked BEFORE any row, in both writers. That order is what makes the family free of
  // lock cycles, and losing it does not fail a test — it produces a deadlock under an interleaving
  // no test can force (a target read as an AGENT while somebody promotes it).
  test("both writers lock the scope before they lock a row", async () => {
    const src = await Bun.file(
      new URL("../../src/api/features/admin/admin.service.ts", import.meta.url),
    ).text();
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    for (const fn of ["updateUserRole", "deleteUser"]) {
      const start = code.indexOf(`export async function ${fn}(`);
      const body = code.slice(start, code.indexOf("\nexport ", start + 1));
      const scopeLock = body.indexOf("lockAdminScope(");
      const rowLock = body.indexOf("lockUserInScope(");
      expect(scopeLock).toBeGreaterThan(-1);
      expect(rowLock).toBeGreaterThan(scopeLock);
    }
    // And nothing takes the scope lock a second time, which is the shape that would put a scope
    // lock after a row lock and bring the cycle back.
    expect(code.match(/await lockAdminScope\(/g) ?? []).toHaveLength(2);
  });

  // Run two writers so they read the scope at the same instant, and PROVE they did: both are parked
  // on rows a third transaction holds, both are asserted to be blocked by it, and only then is it
  // released. Started plain, the two just run one after the other on a quiet machine — measured,
  // that is exactly what happened, and the race test passed against the tree that has the defect.
  async function bothAtOnce(
    rows: bigint[],
    writers: Array<() => Promise<unknown>>,
  ): Promise<Array<PromiseSettledResult<unknown>>> {
    const holder = await holdRows(rows);
    const running = writers.map((w) => w());
    const settled = Promise.allSettled(running);
    const iterations = await waitUntilBlocked(suDb, holder.pid, writers.length);
    expect(iterations).toBeGreaterThanOrEqual(0);
    holder.release();
    await holder.done;
    return settled;
  }

  // The half the delete's own NOTE admits: two writes aimed at DIFFERENT administrators of the same
  // tenant lock different rows, so each reads the other as remaining and the tenant ends with none.
  // Run together, not interleaved by hand: what has to hold is that they cannot BOTH win, however
  // the engine orders them.
  test("two deletes aimed at different administrators cannot both win", async () => {
    const { tenantId, adminIds } = await scope(2);
    const [a, b] = adminIds as [bigint, bigint];
    const outcomes = await bothAtOnce(adminIds as bigint[], [
      () => deleteUser(actor(tenantId, 999_999n), a, appDb),
      () => deleteUser(actor(tenantId, 999_999n), b, appDb),
    ]);
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      LastAdminError,
    );
    expect(await adminsOf(tenantId)).toBe(1);
  });

  // Same race across the two functions, which is the shape the fix has to answer as one invariant
  // rather than as two guards: whoever loses is refused, and the tenant keeps an administrator.
  test("a delete and a demote aimed at different administrators cannot both win", async () => {
    const { tenantId, adminIds } = await scope(2);
    const [a, b] = adminIds as [bigint, bigint];
    const outcomes = await bothAtOnce(adminIds as bigint[], [
      () => deleteUser(actor(tenantId, 999_999n), a, appDb),
      () =>
        updateUserRole(actor(tenantId, 999_999n), b, { role: "AGENT" }, appDb),
    ]);
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      LastAdminError,
    );
    expect(await adminsOf(tenantId)).toBe(1);
  });
});
