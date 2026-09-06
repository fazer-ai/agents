import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  deleteUser,
  EmailTakenInTenantError,
  TenantNotChangeableError,
  TenantNotFoundError,
  TenantRequiredError,
  updateUserRole,
} from "@/api/features/admin/admin.service";
import type { TenantContext } from "@/lib/tenancy";
import { waitUntilBlocked } from "@/tests/utils/pg-waits";

// A fleet administrator belongs to NO tenant and everybody else belongs to one — `users_role_tenant_check`
// says so — which makes "demote this super admin" a transition that cannot be stored unless the write
// also says where the person lands. It used to be attempted anyway, and the operator got the check
// constraint back as a 500 (#534). Every refusal here is one the DATABASE would have made, asked
// earlier and in the operator's terms.
const fleet = (userId: bigint): TenantContext => ({
  tenantId: null,
  userId,
  role: "SUPER_ADMIN",
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

describe.skipIf(!dbUp)("demoting a fleet administrator", () => {
  const tenants: bigint[] = [];
  const users: bigint[] = [];
  let seq = 0;

  // A second fleet administrator, always, so the last-admin guard (#496) is not what answers these
  // tests: what is under test is the transition, not the invariant one function above it.
  async function fleetAdmin(
    tag: string,
  ): Promise<{ id: bigint; email: string }> {
    seq += 1;
    const email = `sd-${process.pid}-${seq}-${tag}@x.test`;
    const row = await suDb.user.create({
      data: { tenantId: null, email, role: "SUPER_ADMIN", passwordHash: "x" },
      select: { id: true },
    });
    users.push(row.id);
    return { id: row.id, email };
  }

  async function tenant(tag: string): Promise<bigint> {
    seq += 1;
    const t = await suDb.tenant.create({
      data: { name: `SD${seq}`, slug: `sd-${process.pid}-${seq}-${tag}` },
      select: { id: true },
    });
    tenants.push(t.id);
    return t.id;
  }

  const rowOf = (id: bigint) =>
    suDb.user.findUnique({
      where: { id },
      select: { role: true, tenantId: true },
    });

  afterAll(async () => {
    if (users.length > 0) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM users WHERE id IN (${users.join(",")})`,
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

  // The report's own case, and it is not an edge one: a fleet administrator ALWAYS has a null tenant,
  // so before this every demotion of every super admin came back as a 500.
  test("a demotion that names no tenant is refused, and the row is untouched", async () => {
    const keep = await fleetAdmin("keep");
    const target = await fleetAdmin("target");
    await expect(
      updateUserRole(fleet(keep.id), target.id, { role: "AGENT" }, appDb),
    ).rejects.toBeInstanceOf(TenantRequiredError);
    expect(await rowOf(target.id)).toEqual({
      role: "SUPER_ADMIN",
      tenantId: null,
    });
  });

  // The transition itself, which nothing could express before: role and tenant move together, in one
  // statement, because the constraint reads both columns of the new row at once.
  test("a demotion that names a tenant moves the person into it", async () => {
    const keep = await fleetAdmin("keep2");
    const target = await fleetAdmin("moved");
    const home = await tenant("home");
    const after = await updateUserRole(
      fleet(keep.id),
      target.id,
      { role: "AGENT", tenantId: home },
      appDb,
    );
    expect(after.role).toBe("AGENT");
    expect(after.tenantId).toBe(home);
    expect(await rowOf(target.id)).toEqual({ role: "AGENT", tenantId: home });
  });

  test("a tenant that does not exist is refused before the write", async () => {
    const keep = await fleetAdmin("keep3");
    const target = await fleetAdmin("nowhere");
    await expect(
      updateUserRole(
        fleet(keep.id),
        target.id,
        { role: "AGENT", tenantId: 9_999_999_999n },
        appDb,
      ),
    ).rejects.toBeInstanceOf(TenantNotFoundError);
    expect(await rowOf(target.id)).toEqual({
      role: "SUPER_ADMIN",
      tenantId: null,
    });
  });

  // `users_tenant_email_key` is on `lower(email)`, so the clash this has to catch is the one that
  // differs only in case — the shape a comparison written with `equals` alone would let through.
  test("an address already used in that tenant is refused, case-insensitively", async () => {
    const keep = await fleetAdmin("keep4");
    const target = await fleetAdmin("clash");
    const home = await tenant("taken");
    const squatter = await suDb.user.create({
      data: {
        tenantId: home,
        email: target.email.toUpperCase(),
        role: "AGENT",
        passwordHash: "x",
      },
      select: { id: true },
    });
    users.push(squatter.id);
    await expect(
      updateUserRole(
        fleet(keep.id),
        target.id,
        { role: "AGENT", tenantId: home },
        appDb,
      ),
    ).rejects.toBeInstanceOf(EmailTakenInTenantError);
    expect(await rowOf(target.id)).toEqual({
      role: "SUPER_ADMIN",
      tenantId: null,
    });
  });

  // The clash test above and this one are the same comparison from its two sides. `lower(email)` is
  // what the index compares, and what Prisma's `mode: "insensitive"` compares is a PATTERN: measured,
  // `a_b@…` matches a stored `axb@…` under ILIKE, so an address with an underscore in it would have
  // been refused a move nothing was wrong with.
  test("an address that merely looks like a pattern does not block the move", async () => {
    const keep = await fleetAdmin("keep5");
    const home = await tenant("wildcard");
    seq += 1;
    const stem = `sd-${process.pid}-${seq}`;
    const target = await suDb.user.create({
      data: {
        tenantId: null,
        email: `${stem}-a_b@x.test`,
        role: "SUPER_ADMIN",
        passwordHash: "x",
      },
      select: { id: true },
    });
    users.push(target.id);
    const lookalike = await suDb.user.create({
      data: {
        tenantId: home,
        email: `${stem}-axb@x.test`,
        role: "AGENT",
        passwordHash: "x",
      },
      select: { id: true },
    });
    users.push(lookalike.id);
    const after = await updateUserRole(
      fleet(keep.id),
      target.id,
      { role: "AGENT", tenantId: home },
      appDb,
    );
    expect(after.tenantId).toBe(home);
  });

  // Where the row about this person goes. `docs/api-and-fleet.md`: a row about a person joins the
  // trail of the person, and after this write the person is in the tenant they joined — filed under
  // the fleet it would be invisible to the only tenant that gained a member.
  test("the trail row is filed under the tenant the person joined", async () => {
    const keep = await fleetAdmin("keep6");
    const target = await fleetAdmin("audited");
    const home = await tenant("trail");
    await updateUserRole(
      fleet(keep.id),
      target.id,
      { role: "AGENT", tenantId: home },
      appDb,
    );
    const rows = await suDb.auditLog.findMany({
      where: { action: "user.role_set", target: `user:${target.id}` },
      select: { tenantId: true },
    });
    expect(rows.map((r) => r.tenantId)).toEqual([home]);
  });

  // The lock this family takes is chosen from an unlocked read, and THIS PR is what made that read
  // able to go stale: before it, nothing wrote `users.tenant_id` after creation. A write that starts
  // while a demotion is uncommitted therefore queues on the FLEET scope and wakes up holding it while
  // the target now lives in a tenant — and its guard would then count that tenant's administrators
  // under a lock covering somebody else's scope, which is how two removals in one tenant both commit.
  //
  // Proved by where the write WAITS, not by timing: the second holder owns the destination scope's
  // advisory lock, so a write that re-reads its scope has to park on it, and one that kept the stale
  // scope sails past and the wait below never fires.
  test("a write whose target moved scope waits for the scope it lands in", async () => {
    const keep = await fleetAdmin("keep7");
    const target = await fleetAdmin("mover");
    const home = await tenant("lands");
    const resident = await suDb.user.create({
      data: {
        tenantId: home,
        email: `sd-${process.pid}-resident@x.test`,
        role: "TENANT_ADMIN",
        passwordHash: "x",
      },
      select: { id: true },
    });
    users.push(resident.id);

    // The move, held open: the target still reads as a fleet administrator to anybody starting now.
    const mover = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl as string }),
    });
    let commitMove!: () => void;
    const moveGate = new Promise<void>((r) => {
      commitMove = r;
    });
    let moverReady!: (pid: number) => void;
    const moverPid = new Promise<number>((r) => {
      moverReady = r;
    });
    const moveDone = mover
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE users SET role = 'TENANT_ADMIN', tenant_id = ${home} WHERE id = ${target.id}`,
          );
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid()::int AS pid`;
          moverReady(row?.pid ?? 0);
          await moveGate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
      .then(() => mover.$disconnect());

    // The destination scope, held by somebody else, which is what the write has to ask for once it
    // learns where its target went.
    const scoped = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl as string }),
    });
    let releaseScope!: () => void;
    const scopeGate = new Promise<void>((r) => {
      releaseScope = r;
    });
    let scopeReady!: (pid: number) => void;
    const scopePid = new Promise<number>((r) => {
      scopeReady = r;
    });
    const scopeDone = scoped
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext('admin-scope:${home}')::bigint)`,
          );
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid()::int AS pid`;
          scopeReady(row?.pid ?? 0);
          await scopeGate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
      .then(() => scoped.$disconnect());

    const movePid = await moverPid;
    const heldScopePid = await scopePid;
    const removing = deleteUser(fleet(keep.id), target.id, appDb).catch(
      (e: Error) => e,
    );
    // First it parks on the target's row, still believing the target is in the fleet.
    expect(await waitUntilBlocked(suDb, movePid, 1)).toBeGreaterThanOrEqual(0);
    commitMove();
    await moveDone;
    // And then, having learnt where the target actually is, on that tenant's scope.
    expect(
      await waitUntilBlocked(suDb, heldScopePid, 1),
    ).toBeGreaterThanOrEqual(0);
    releaseScope();
    await scopeDone;
    expect(await removing).toBeUndefined();
    expect(await rowOf(target.id)).toBeNull();
    expect(await rowOf(resident.id)).toEqual({
      role: "TENANT_ADMIN",
      tenantId: home,
    });
  }, 30_000);

  // The field means one thing, and it is not "move this person": for somebody who already belongs to
  // a tenant, a role change says nothing about which one, and accepting it here would make this
  // endpoint a transfer nobody reviewed.
  test("naming a tenant for anybody else is refused", async () => {
    const home = await tenant("stay");
    const elsewhere = await tenant("elsewhere");
    seq += 1;
    const member = await suDb.user.create({
      data: {
        tenantId: home,
        email: `sd-${process.pid}-${seq}-member@x.test`,
        role: "AGENT",
        passwordHash: "x",
      },
      select: { id: true },
    });
    users.push(member.id);
    await expect(
      updateUserRole(
        fleet(9_999_998n),
        member.id,
        { role: "TENANT_ADMIN", tenantId: elsewhere },
        appDb,
      ),
    ).rejects.toBeInstanceOf(TenantNotChangeableError);
    expect(await rowOf(member.id)).toEqual({ role: "AGENT", tenantId: home });
  });
});
