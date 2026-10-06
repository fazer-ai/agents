import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  AlreadySuperAdminError,
  addSuperAdmin,
  getUsers,
  previewSuperAdmin,
  updateUserRole,
} from "@/api/features/admin/admin.service";
import { verifyPassword } from "@/api/features/auth/auth.service";
import {
  acceptInvite,
  createFleetInvite,
  FleetInviteForbiddenError,
  findValidInviteByToken,
  InviteAccountProofError,
  InviteEmailInUseError,
  InviteInvalidError,
  InviteNotFoundError,
  listInvites,
  revokeInvite,
} from "@/api/features/invitations/invitation.service";
import type { TenantContext } from "@/lib/tenancy";
import { personData } from "@/tests/utils/person";
import { waitUntilBlocked } from "@/tests/utils/pg-waits";

// A fleet administrator making another person one: an existing account is promoted on the spot, an
// email with no account gets a fleet invitation (no tenant, a day long, single-use). Real Postgres,
// because the invariants are a CHECK, a partial unique index and the fleet trail under RLS.

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!dbUp)("addSuperAdmin and the fleet invitation (DB)", () => {
  const pid = process.pid;
  const mail = (name: string) => `${name}-${pid}@sa.test`;
  let tenantA = 0n;
  let tenantB = 0n;
  let fleet: TenantContext;
  let tenantAdmin: TenantContext;

  const auditRows = (target: string) =>
    suDb.auditLog.findMany({
      where: { target },
      select: { tenantId: true, action: true, actorId: true, after: true },
    });

  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({ data: { name: "SA-A", slug: `sa-a-${pid}` } })
    ).id;
    tenantB = (
      await suDb.tenant.create({ data: { name: "SA-B", slug: `sa-b-${pid}` } })
    ).id;
    const root = await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("root"),
        role: "SUPER_ADMIN",
      }),
    });
    fleet = { tenantId: null, userId: root.id, role: "SUPER_ADMIN" };
    const admin = await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("tadmin"),
        role: "TENANT_ADMIN",
        tenantId: tenantA,
      }),
    });
    tenantAdmin = { tenantId: tenantA, userId: admin.id, role: "TENANT_ADMIN" };
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM invitations WHERE email LIKE '%-${pid}@sa.test'`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE after::text LIKE '%-${pid}@sa.test%'`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM users WHERE email LIKE '%-${pid}@sa.test'`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`,
    );
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("an existing account becomes SUPER_ADMIN at once and keeps every membership", async () => {
    const person = await suDb.user.create({
      data: {
        email: mail("existing"),
        passwordHash: "unused",
        memberships: {
          create: [
            { tenantId: tenantA, role: "TENANT_ADMIN" },
            { tenantId: tenantB, role: "AGENT" },
          ],
        },
      },
    });
    const result = await addSuperAdmin(fleet, mail("EXISTING"), appDb);
    expect(result.kind).toBe("promoted");

    const after = await suDb.user.findUniqueOrThrow({
      where: { id: person.id },
      select: {
        isSuperAdmin: true,
        memberships: {
          select: { tenantId: true, role: true },
          orderBy: { tenantId: "asc" },
        },
      },
    });
    expect(after.isSuperAdmin).toBe(true);
    expect(after.memberships).toEqual([
      { tenantId: tenantA, role: "TENANT_ADMIN" },
      { tenantId: tenantB, role: "AGENT" },
    ]);
    expect(
      await suDb.invitation.count({ where: { email: mail("existing") } }),
    ).toBe(0);

    const audit = await auditRows(`user:${person.id}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.tenantId).toBeNull();
    expect(audit[0]?.action).toBe("user.role_set");
    expect(audit[0]?.actorId).toBe(fleet.userId);
    expect((audit[0]?.after as { role?: string } | undefined)?.role).toBe(
      "SUPER_ADMIN",
    );
  });

  test("promoting a SUPER_ADMIN again is refused and writes nothing", async () => {
    const person = await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("already"),
        role: "SUPER_ADMIN",
      }),
    });
    await expect(
      addSuperAdmin(fleet, mail("already"), appDb),
    ).rejects.toBeInstanceOf(AlreadySuperAdminError);
    expect(await auditRows(`user:${person.id}`)).toHaveLength(0);
    expect(
      await suDb.invitation.count({ where: { email: mail("already") } }),
    ).toBe(0);
  });

  test("anyone but a SUPER_ADMIN is refused before anything is written", async () => {
    const person = await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("target"),
        role: "AGENT",
        tenantId: tenantA,
      }),
    });
    for (const email of [mail("target"), mail("nobody")]) {
      await expect(
        addSuperAdmin(tenantAdmin, email, appDb),
      ).rejects.toBeInstanceOf(FleetInviteForbiddenError);
    }
    const after = await suDb.user.findUniqueOrThrow({
      where: { id: person.id },
    });
    expect(after.isSuperAdmin).toBe(false);
    expect(
      await suDb.invitation.count({ where: { email: mail("nobody") } }),
    ).toBe(0);
  });

  test("a fleet invitation is minted only by a SUPER_ADMIN, whoever calls the service", async () => {
    await expect(
      createFleetInvite(tenantAdmin, mail("direct"), appDb),
    ).rejects.toBeInstanceOf(FleetInviteForbiddenError);
    expect(
      await suDb.invitation.count({ where: { email: mail("direct") } }),
    ).toBe(0);
  });

  test("two simultaneous accepts of one link: one account, the other refused as used", async () => {
    const result = await addSuperAdmin(fleet, mail("twice"), appDb);
    if (result.kind !== "invited") throw new Error("expected an invitation");
    const outcomes = await Promise.allSettled([
      acceptInvite(
        { token: result.invite.token, password: "first pass 1" },
        appDb,
      ),
      acceptInvite(
        { token: result.invite.token, password: "second pass 2" },
        appDb,
      ),
    ]);
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      InviteInvalidError,
    );
    expect(await suDb.user.count({ where: { email: mail("twice") } })).toBe(1);
  });

  test("an email with no account gets a one-day fleet invitation, audited without its token", async () => {
    const before = Date.now();
    const result = await addSuperAdmin(fleet, mail("Newcomer"), appDb);
    if (result.kind !== "invited") throw new Error("expected an invitation");
    const row = await suDb.invitation.findUniqueOrThrow({
      where: { id: result.invite.id },
    });
    expect(row.tenantId).toBeNull();
    expect(row.role).toBe("SUPER_ADMIN");
    expect(row.email).toBe(mail("newcomer"));
    expect(row.invitedById).toBe(fleet.userId);
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThan(24 * HOUR_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(24 * HOUR_MS + 60_000);

    const audit = await auditRows(`invitation:${row.id}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.tenantId).toBeNull();
    expect(audit[0]?.action).toBe("invitation.create");
    const text = JSON.stringify(audit[0]?.after);
    expect(text).not.toContain(result.invite.token);
    expect(text).not.toContain(row.tokenHash);

    const shown = await findValidInviteByToken(result.invite.token, appDb);
    expect(shown).toEqual({
      email: mail("newcomer"),
      role: "SUPER_ADMIN",
      existingAccount: false,
    });
  });

  test("accepting creates the account as a SUPER_ADMIN with no membership, once", async () => {
    const result = await addSuperAdmin(fleet, mail("accepts"), appDb);
    if (result.kind !== "invited") throw new Error("expected an invitation");
    const session = await acceptInvite(
      { token: result.invite.token, password: "correct horse 1" },
      appDb,
    );
    expect(session.role).toBe("SUPER_ADMIN");
    expect(session.tenantId).toBeNull();
    expect(session.joinedTenantId).toBeNull();

    const person = await suDb.user.findFirstOrThrow({
      where: { email: mail("accepts") },
      select: {
        id: true,
        isSuperAdmin: true,
        passwordHash: true,
        memberships: { select: { tenantId: true } },
      },
    });
    expect(person.isSuperAdmin).toBe(true);
    expect(person.memberships).toEqual([]);
    expect(
      await verifyPassword("correct horse 1", person.passwordHash as string),
    ).toBe(true);
    const audit = await auditRows(`user:${person.id}`);
    expect(audit.map((a) => [a.action, a.tenantId, a.actorId])).toEqual([
      ["user.role_set", null, person.id],
    ]);

    await expect(
      acceptInvite(
        { token: result.invite.token, password: "another pass 2" },
        appDb,
      ),
    ).rejects.toBeInstanceOf(InviteInvalidError);
  });

  test("an account created after the invitation must prove itself, then is promoted keeping its tenant", async () => {
    const result = await addSuperAdmin(fleet, mail("latecomer"), appDb);
    if (result.kind !== "invited") throw new Error("expected an invitation");
    const { hashPassword } = await import("@/api/features/auth/auth.service");
    const person = await suDb.user.create({
      data: {
        email: mail("latecomer"),
        passwordHash: await hashPassword("their own pass"),
        memberships: { create: { tenantId: tenantB, role: "AGENT" } },
      },
    });
    await expect(
      acceptInvite(
        { token: result.invite.token, password: "attacker pass" },
        appDb,
      ),
    ).rejects.toBeInstanceOf(InviteAccountProofError);
    expect(
      (await suDb.user.findUniqueOrThrow({ where: { id: person.id } }))
        .isSuperAdmin,
    ).toBe(false);

    await acceptInvite(
      { token: result.invite.token, password: "their own pass" },
      appDb,
    );
    const after = await suDb.user.findUniqueOrThrow({
      where: { id: person.id },
      select: {
        isSuperAdmin: true,
        passwordHash: true,
        memberships: { select: { tenantId: true, role: true } },
      },
    });
    expect(after.isSuperAdmin).toBe(true);
    expect(after.memberships).toEqual([{ tenantId: tenantB, role: "AGENT" }]);
    expect(
      await verifyPassword("their own pass", after.passwordHash ?? ""),
    ).toBe(true);
  });

  test("a fleet invitation for someone who became SUPER_ADMIN meanwhile answers in-use", async () => {
    const result = await addSuperAdmin(fleet, mail("raced"), appDb);
    if (result.kind !== "invited") throw new Error("expected an invitation");
    await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("raced"),
        role: "SUPER_ADMIN",
      }),
    });
    await expect(
      acceptInvite(
        { token: result.invite.token, password: "whatever 12" },
        appDb,
      ),
    ).rejects.toBeInstanceOf(InviteEmailInUseError);
  });

  test("issuing again rotates the link: the previous token stops working", async () => {
    const first = await addSuperAdmin(fleet, mail("rotate"), appDb);
    const second = await addSuperAdmin(fleet, mail("rotate"), appDb);
    if (first.kind !== "invited" || second.kind !== "invited") {
      throw new Error("expected invitations");
    }
    expect(await findValidInviteByToken(first.invite.token, appDb)).toBeNull();
    expect(
      await findValidInviteByToken(second.invite.token, appDb),
    ).not.toBeNull();
    expect(
      await suDb.invitation.count({ where: { email: mail("rotate") } }),
    ).toBe(1);
  });

  test("an expired fleet invitation is refused", async () => {
    const result = await addSuperAdmin(fleet, mail("expired"), appDb);
    if (result.kind !== "invited") throw new Error("expected an invitation");
    await suDb.invitation.update({
      where: { id: result.invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await findValidInviteByToken(result.invite.token, appDb)).toBeNull();
    await expect(
      acceptInvite(
        { token: result.invite.token, password: "late pass 12" },
        appDb,
      ),
    ).rejects.toBeInstanceOf(InviteInvalidError);
    expect(await suDb.user.count({ where: { email: mail("expired") } })).toBe(
      0,
    );
  });

  test("a tenant administrator neither lists nor revokes a fleet invitation; the fleet does both", async () => {
    const result = await addSuperAdmin(fleet, mail("listed"), appDb);
    if (result.kind !== "invited") throw new Error("expected an invitation");
    const id = String(result.invite.id);

    expect((await listInvites(tenantA, appDb)).map((i) => i.id)).not.toContain(
      id,
    );
    await expect(
      revokeInvite(tenantAdmin, result.invite.id, appDb),
    ).rejects.toBeInstanceOf(InviteNotFoundError);
    expect(
      await findValidInviteByToken(result.invite.token, appDb),
    ).not.toBeNull();

    const fleetList = await listInvites(null, appDb);
    expect(fleetList.find((i) => i.id === id)).toMatchObject({
      tenantId: null,
      role: "SUPER_ADMIN",
      status: "pending",
    });
    await revokeInvite(fleet, result.invite.id, appDb);
    expect(await findValidInviteByToken(result.invite.token, appDb)).toBeNull();
  });

  test("the schema ties SUPER_ADMIN to the missing tenant and keeps one fleet invitation per email", async () => {
    const insert = (tenant: string, role: string, email: string) =>
      suDb.$executeRawUnsafe(
        `INSERT INTO invitations (tenant_id, email, role, token_hash, expires_at, updated_at)
         VALUES (${tenant}, '${email}', '${role}', 'h-${pid}-${Math.random()}', now() + interval '1 day', now())`,
      );
    const refuses = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return false;
      } catch {
        return true;
      }
    };
    expect(await refuses(() => insert("NULL", "AGENT", mail("chk1")))).toBe(
      true,
    );
    expect(
      await refuses(() => insert(String(tenantA), "SUPER_ADMIN", mail("chk2"))),
    ).toBe(true);
    expect(
      await refuses(() => insert("NULL", "SUPER_ADMIN", mail("chk3"))),
    ).toBe(false);
    expect(
      await refuses(() => insert("NULL", "SUPER_ADMIN", mail("chk3"))),
    ).toBe(true);
  });

  test("removing the fleet grant from a person with memberships keeps them exactly, and names no tenant", async () => {
    const person = await suDb.user.create({
      data: {
        email: mail("grants"),
        passwordHash: "unused",
        isSuperAdmin: true,
        memberships: {
          create: [
            { tenantId: tenantA, role: "TENANT_ADMIN" },
            { tenantId: tenantB, role: "AGENT" },
          ],
        },
      },
    });
    const row = await updateUserRole(
      fleet,
      person.id,
      { role: "AGENT", demoteFleet: true },
      appDb,
    );
    expect([row.tenantId, row.role]).toEqual([tenantA, "TENANT_ADMIN"]);
    const after = await suDb.user.findUniqueOrThrow({
      where: { id: person.id },
      select: {
        isSuperAdmin: true,
        memberships: {
          select: { tenantId: true, role: true },
          orderBy: { tenantId: "asc" },
        },
      },
    });
    expect(after).toEqual({
      isSuperAdmin: false,
      memberships: [
        { tenantId: tenantA, role: "TENANT_ADMIN" },
        { tenantId: tenantB, role: "AGENT" },
      ],
    });
    const audit = await auditRows(`user:${person.id}`);
    expect(audit.map((a) => [a.action, a.tenantId])).toEqual([
      ["user.role_set", null],
    ]);
  });

  test("the fleet list shows a super admin once, carrying their memberships; a tenant's list shows their role there", async () => {
    const person = await suDb.user.create({
      data: {
        email: mail("listed-once"),
        passwordHash: "unused",
        isSuperAdmin: true,
        memberships: {
          create: [
            { tenantId: tenantA, role: "TENANT_ADMIN" },
            { tenantId: tenantB, role: "AGENT" },
          ],
        },
      },
    });
    const fleetView = await getUsers(null, 1, mail("listed-once"), appDb);
    expect(
      fleetView.users.map((u) => [u.id, u.tenantId, u.role, u.memberships]),
    ).toEqual([
      [
        person.id,
        null,
        "SUPER_ADMIN",
        [
          { tenantId: tenantA, role: "TENANT_ADMIN" },
          { tenantId: tenantB, role: "AGENT" },
        ],
      ],
    ]);
    expect(fleetView.total).toBe(1);
    const tenantView = await getUsers(tenantB, 1, mail("listed-once"), appDb);
    expect(tenantView.users.map((u) => [u.tenantId, u.role])).toEqual([
      [tenantB, "AGENT"],
    ]);
  });

  test("the preview answers by exact email, and only to a SUPER_ADMIN", async () => {
    await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("pv-member"),
        role: "AGENT",
        tenantId: tenantA,
      }),
    });
    await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("pv-fleet"),
        role: "SUPER_ADMIN",
      }),
    });
    expect(await previewSuperAdmin(fleet, mail("PV-member"), appDb)).toBe(
      "promote",
    );
    expect(await previewSuperAdmin(fleet, mail("pv-fleet"), appDb)).toBe(
      "already",
    );
    expect(await previewSuperAdmin(fleet, mail("pv-mem"), appDb)).toBe(
      "invite",
    );
    await expect(
      previewSuperAdmin(tenantAdmin, mail("pv-member"), appDb),
    ).rejects.toBeInstanceOf(FleetInviteForbiddenError);
  });

  test("promoting an account drops the fleet invitation still pending for its email", async () => {
    const issued = await addSuperAdmin(fleet, mail("stale-link"), appDb);
    if (issued.kind !== "invited") throw new Error("expected an invitation");
    await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("stale-link"),
        role: "AGENT",
        tenantId: tenantA,
      }),
    });
    const promoted = await addSuperAdmin(fleet, mail("stale-link"), appDb);
    expect(promoted.kind).toBe("promoted");
    expect(await findValidInviteByToken(issued.invite.token, appDb)).toBeNull();
    expect(
      await suDb.invitation.count({ where: { email: mail("stale-link") } }),
    ).toBe(0);
  });

  test("removing the fleet grant drops a fleet invitation pending for that email", async () => {
    const issued = await addSuperAdmin(fleet, mail("demoted-link"), appDb);
    if (issued.kind !== "invited") throw new Error("expected an invitation");
    const person = await suDb.user.create({
      data: {
        email: mail("demoted-link"),
        passwordHash: "unused",
        isSuperAdmin: true,
        memberships: { create: { tenantId: tenantA, role: "AGENT" } },
      },
    });
    await updateUserRole(
      fleet,
      person.id,
      { role: "AGENT", demoteFleet: true },
      appDb,
    );
    expect(await findValidInviteByToken(issued.invite.token, appDb)).toBeNull();
  });

  test("demoting a membership-less super admin into a tenant drops a fleet invitation pending for them", async () => {
    const issued = await addSuperAdmin(fleet, mail("joined-link"), appDb);
    if (issued.kind !== "invited") throw new Error("expected an invitation");
    const person = await suDb.user.create({
      data: personData({
        passwordHash: "unused",
        email: mail("joined-link"),
        role: "SUPER_ADMIN",
      }),
    });
    await updateUserRole(
      fleet,
      person.id,
      { role: "TENANT_ADMIN", tenantId: tenantB, demoteFleet: true },
      appDb,
    );
    expect(await findValidInviteByToken(issued.invite.token, appDb)).toBeNull();
  });

  test("two simultaneous fleet invitations for one new email: both answer, one row is left", async () => {
    const results = await Promise.allSettled([
      createFleetInvite(fleet, mail("racing-issue"), appDb),
      createFleetInvite(fleet, mail("racing-issue"), appDb),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(
      await suDb.invitation.count({ where: { email: mail("racing-issue") } }),
    ).toBe(1);
  });

  test("accepting a fleet invitation while the same person is promoted queues instead of deadlocking", async () => {
    const issued = await addSuperAdmin(fleet, mail("lock-order"), appDb);
    if (issued.kind !== "invited") throw new Error("expected an invitation");
    const { hashPassword } = await import("@/api/features/auth/auth.service");
    const person = await suDb.user.create({
      data: {
        email: mail("lock-order"),
        passwordHash: await hashPassword("lock order 1"),
        memberships: { create: { tenantId: tenantA, role: "AGENT" } },
      },
    });
    // A third session holds the person, so the promotion queues first and the accept second.
    const conn = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl as string }),
    });
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let ready: (pid: number) => void = () => {};
    const got = new Promise<number>((r) => {
      ready = r;
    });
    const held = conn
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${person.id} FOR UPDATE`;
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid()::int AS pid`;
          ready(row?.pid ?? 0);
          await gate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
      .then(() => conn.$disconnect());
    const holder = await got;
    const promote = addSuperAdmin(fleet, mail("lock-order"), appDb);
    expect(await waitUntilBlocked(suDb, holder, 1)).toBeGreaterThanOrEqual(0);
    const accept = acceptInvite(
      { token: issued.invite.token, password: "lock order 1" },
      appDb,
    );
    expect(await waitUntilBlocked(suDb, holder, 2)).toBeGreaterThanOrEqual(0);
    release();
    await held;
    const [p, a] = await Promise.allSettled([promote, accept]);
    expect(p.status).toBe("fulfilled");
    expect(a.status).toBe("rejected");
    expect((a as PromiseRejectedResult).reason).toBeInstanceOf(
      InviteInvalidError,
    );
    expect(
      (await suDb.user.findUniqueOrThrow({ where: { id: person.id } }))
        .isSuperAdmin,
    ).toBe(true);
  });
});
