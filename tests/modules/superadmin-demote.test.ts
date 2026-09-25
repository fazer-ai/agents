import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  deleteUser,
  LastAdminError,
  TenantNotChangeableError,
  TenantNotFoundError,
  TenantRequiredError,
  UserNotInScopeError,
  updateUserRole,
} from "@/api/features/admin/admin.service";
import type { TenantContext } from "@/lib/tenancy";
import { personData } from "@/tests/utils/person";
import { waitUntilBlocked } from "@/tests/utils/pg-waits";

// A fleet administrator needs no membership, and everybody else enters through one: taking the fleet
// role away therefore has to say which tenant the person keeps working in, or it leaves an account
// with nowhere to enter. It used to be attempted anyway, and the operator got a check constraint back
// as a 500 (#534). Since issue #756 the role is held PER MEMBERSHIP, so the fleet also has to say
// which membership it re-roles when the person has more than one.
const fleet = (userId: bigint): TenantContext => ({
  tenantId: null,
  userId,
  role: "SUPER_ADMIN",
});
const tenantAdmin = (tenantId: bigint, userId: bigint): TenantContext => ({
  tenantId,
  userId,
  role: "TENANT_ADMIN",
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
      data: personData({
        tenantId: null,
        email,
        role: "SUPER_ADMIN",
        passwordHash: "x",
      }),
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

  // The person as the schema holds them: the fleet role, and the memberships with their roles.
  const rowOf = async (id: bigint) => {
    const u = await suDb.user.findUnique({
      where: { id },
      select: {
        isSuperAdmin: true,
        memberships: {
          select: { tenantId: true, role: true },
          orderBy: { tenantId: "asc" },
        },
      },
    });
    return u;
  };
  const fleetRow = { isSuperAdmin: true, memberships: [] };

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
      updateUserRole(
        fleet(keep.id),
        target.id,
        { role: "AGENT", demoteFleet: true },
        appDb,
      ),
    ).rejects.toBeInstanceOf(TenantRequiredError);
    expect(await rowOf(target.id)).toEqual(fleetRow);
  });

  // The transition itself: the fleet role goes and the membership arrives in the same transaction.
  test("a demotion that names a tenant moves the person into it", async () => {
    const keep = await fleetAdmin("keep2");
    const target = await fleetAdmin("moved");
    const home = await tenant("home");
    const after = await updateUserRole(
      fleet(keep.id),
      target.id,
      { role: "AGENT", tenantId: home, demoteFleet: true },
      appDb,
    );
    expect(after.role).toBe("AGENT");
    expect(after.tenantId).toBe(home);
    expect(await rowOf(target.id)).toEqual({
      isSuperAdmin: false,
      memberships: [{ tenantId: home, role: "AGENT" }],
    });
  });

  test("a tenant that does not exist is refused before the write", async () => {
    const keep = await fleetAdmin("keep3");
    const target = await fleetAdmin("nowhere");
    await expect(
      updateUserRole(
        fleet(keep.id),
        target.id,
        { role: "AGENT", tenantId: 9_999_999_999n, demoteFleet: true },
        appDb,
      ),
    ).rejects.toBeInstanceOf(TenantNotFoundError);
    expect(await rowOf(target.id)).toEqual(fleetRow);
  });

  // A fleet administrator who already belongs to the tenant (two rows of one person merged by the
  // #756 migration keep both) ends with ONE membership there, carrying the role the demotion names.
  test("a demotion into a tenant the person already belongs to keeps one membership", async () => {
    const keep = await fleetAdmin("keep4");
    const target = await fleetAdmin("member");
    const home = await tenant("already");
    await suDb.tenantUser.create({
      data: { tenantId: home, userId: target.id, role: "AGENT" },
    });
    await updateUserRole(
      fleet(keep.id),
      target.id,
      { role: "TENANT_ADMIN", tenantId: home, demoteFleet: true },
      appDb,
    );
    expect(await rowOf(target.id)).toEqual({
      isSuperAdmin: false,
      memberships: [{ tenantId: home, role: "TENANT_ADMIN" }],
    });
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
      { role: "AGENT", tenantId: home, demoteFleet: true },
      appDb,
    );
    const rows = await suDb.auditLog.findMany({
      where: { action: "user.role_set", target: `user:${target.id}` },
      select: { tenantId: true },
    });
    expect(rows.map((r) => r.tenantId)).toEqual([home]);
  });

  // The locks this family takes are chosen from an unlocked read, and a demotion makes that read stale:
  // a write that starts while one is uncommitted queues on the FLEET scope and wakes up holding it
  // while the target now administers a tenant — and its guard would then count that tenant's
  // administrators under a lock covering somebody else's scope, which is how two removals in one
  // tenant both commit.
  //
  // Proved by where the write WAITS, not by timing: the second holder owns the destination scope's
  // advisory lock, so a write that re-reads its scope has to park on it, and one that kept the stale
  // scope sails past and the wait below never fires.
  test("a write whose target moved scope waits for the scope it lands in", async () => {
    const keep = await fleetAdmin("keep7");
    const target = await fleetAdmin("mover");
    const home = await tenant("lands");
    const resident = await suDb.user.create({
      data: personData({
        tenantId: home,
        email: `sd-${process.pid}-resident@x.test`,
        role: "TENANT_ADMIN",
        passwordHash: "x",
      }),
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
            `UPDATE users SET is_super_admin = false WHERE id = ${target.id}`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO tenant_users (tenant_id, user_id, role, updated_at)
             VALUES (${home}, ${target.id}, 'TENANT_ADMIN', now())`,
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
      isSuperAdmin: false,
      memberships: [{ tenantId: home, role: "TENANT_ADMIN" }],
    });
  }, 30_000);

  // The field names a MEMBERSHIP, and it is not "move this person": naming a tenant the person does not
  // belong to finds nobody there to re-role, and accepting it would make this endpoint a transfer
  // nobody reviewed.
  test("the fleet naming a tenant the person does not belong to finds nobody", async () => {
    const home = await tenant("stay");
    const elsewhere = await tenant("elsewhere");
    seq += 1;
    const member = await suDb.user.create({
      data: personData({
        tenantId: home,
        email: `sd-${process.pid}-${seq}-member@x.test`,
        role: "AGENT",
        passwordHash: "x",
      }),
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
    ).rejects.toBeInstanceOf(UserNotInScopeError);
    expect(await rowOf(member.id)).toEqual({
      isSuperAdmin: false,
      memberships: [{ tenantId: home, role: "AGENT" }],
    });
  });

  // A person in two tenants holds two roles, so the fleet has to say which one it changes, and only
  // that one moves. With a single membership there is nothing to choose and nothing to name.
  test("the fleet re-roles the membership it names, and must name one when there are two", async () => {
    const first = await tenant("first");
    const second = await tenant("second");
    seq += 1;
    const person = await suDb.user.create({
      data: personData({
        tenantId: first,
        email: `sd-${process.pid}-${seq}-two@x.test`,
        role: "AGENT",
        passwordHash: "x",
      }),
      select: { id: true },
    });
    users.push(person.id);
    await suDb.tenantUser.create({
      data: { tenantId: second, userId: person.id, role: "AGENT" },
    });
    await expect(
      updateUserRole(
        fleet(9_999_998n),
        person.id,
        { role: "TENANT_ADMIN" },
        appDb,
      ),
    ).rejects.toBeInstanceOf(TenantRequiredError);
    await updateUserRole(
      fleet(9_999_998n),
      person.id,
      { role: "TENANT_ADMIN", tenantId: second },
      appDb,
    );
    expect(await rowOf(person.id)).toEqual({
      isSuperAdmin: false,
      memberships: [
        { tenantId: first, role: "AGENT" },
        { tenantId: second, role: "TENANT_ADMIN" },
      ],
    });
  });

  // A tenant administrator's write is fenced to the tenant their session runs under, and naming
  // another is refused rather than read as a move.
  test("a tenant administrator naming another tenant is refused", async () => {
    const home = await tenant("own");
    const elsewhere = await tenant("other");
    seq += 1;
    const member = await suDb.user.create({
      data: personData({
        tenantId: home,
        email: `sd-${process.pid}-${seq}-fenced@x.test`,
        role: "AGENT",
        passwordHash: "x",
      }),
      select: { id: true },
    });
    users.push(member.id);
    await expect(
      updateUserRole(
        tenantAdmin(home, 9_999_997n),
        member.id,
        { role: "TENANT_ADMIN", tenantId: elsewhere },
        appDb,
      ),
    ).rejects.toBeInstanceOf(TenantNotChangeableError);
    expect(await rowOf(member.id)).toEqual({
      isSuperAdmin: false,
      memberships: [{ tenantId: home, role: "AGENT" }],
    });
  });
  // Review round 1: the person may already ADMINISTER the tenant they land in, alone. Replacing that
  // membership's role is a demotion there too, and the tenant keeps an administrator or nothing moves.
  test("a demotion that would leave the destination tenant without an administrator is refused", async () => {
    const keep = await fleetAdmin("keep8");
    const target = await fleetAdmin("lone");
    const home = await tenant("lone");
    await suDb.tenantUser.create({
      data: { tenantId: home, userId: target.id, role: "TENANT_ADMIN" },
    });
    await expect(
      updateUserRole(
        fleet(keep.id),
        target.id,
        { role: "AGENT", tenantId: home, demoteFleet: true },
        appDb,
      ),
    ).rejects.toBeInstanceOf(LastAdminError);
    expect(await rowOf(target.id)).toEqual({
      isSuperAdmin: true,
      memberships: [{ tenantId: home, role: "TENANT_ADMIN" }],
    });
  });

  // Review round 1: a fleet administrator who also holds a membership shows that membership as its
  // own row in the fleet view, and re-roling it is a MEMBERSHIP edit. It must never double as taking
  // the fleet role away.
  test("editing a fleet administrator's membership leaves the fleet role alone", async () => {
    const keep = await fleetAdmin("keep9");
    const target = await fleetAdmin("both");
    const home = await tenant("both");
    await suDb.tenantUser.create({
      data: { tenantId: home, userId: target.id, role: "AGENT" },
    });
    await updateUserRole(
      fleet(keep.id),
      target.id,
      { role: "TENANT_ADMIN", tenantId: home },
      appDb,
    );
    expect(await rowOf(target.id)).toEqual({
      isSuperAdmin: true,
      memberships: [{ tenantId: home, role: "TENANT_ADMIN" }],
    });
  });

  // And the demotion names a fleet administrator, or it finds nobody to demote.
  test("a fleet demotion of somebody outside the fleet finds nobody", async () => {
    const home = await tenant("plain");
    seq += 1;
    const member = await suDb.user.create({
      data: personData({
        tenantId: home,
        email: `sd-${process.pid}-${seq}-plain@x.test`,
        role: "TENANT_ADMIN",
        passwordHash: "x",
      }),
      select: { id: true },
    });
    users.push(member.id);
    await expect(
      updateUserRole(
        fleet(9_999_998n),
        member.id,
        { role: "AGENT", tenantId: home, demoteFleet: true },
        appDb,
      ),
    ).rejects.toBeInstanceOf(UserNotInScopeError);
    expect(await rowOf(member.id)).toEqual({
      isSuperAdmin: false,
      memberships: [{ tenantId: home, role: "TENANT_ADMIN" }],
    });
  });
  // Review round 2: the fleet deleting a person takes the scope of EVERY tenant they belong to, not
  // only the ones they administer. An AGENT membership read at the start can be promoted, and the
  // tenant's previous administrator demoted, before the cascade takes it; holding the tenant's scope
  // is what makes those writes wait and then read the deletion. Proved by where the delete WAITS.
  test("deleting a person waits for the scope of a tenant they only work in", async () => {
    const home = await tenant("agentonly");
    seq += 1;
    const member = await suDb.user.create({
      data: personData({
        tenantId: home,
        email: `sd-${process.pid}-${seq}-agentonly@x.test`,
        role: "AGENT",
        passwordHash: "x",
      }),
      select: { id: true },
    });
    users.push(member.id);
    const holder = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl as string }),
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ready!: (pid: number) => void;
    const holderPid = new Promise<number>((r) => {
      ready = r;
    });
    const held = holder
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(hashtext('admin-scope:${home}')::bigint)`,
          );
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid()::int AS pid`;
          ready(row?.pid ?? 0);
          await gate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
      .then(() => holder.$disconnect());
    const pid = await holderPid;
    const removing = deleteUser(fleet(9_999_998n), member.id, appDb).catch(
      (e: Error) => e,
    );
    expect(await waitUntilBlocked(suDb, pid, 1)).toBeGreaterThanOrEqual(0);
    release();
    await held;
    expect(await removing).toBeUndefined();
    expect(await rowOf(member.id)).toBeNull();
  }, 30_000);
});
