import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  acceptInvite,
  createInvite,
  findValidInviteByToken,
  InviteEmailInUseError,
  InviteInvalidError,
  InviteNotFoundError,
  listInvites,
  revokeInvite,
} from "@/api/features/invitations/invitation.service";
import type { TenantContext } from "@/lib/tenancy";

// Invitation security invariants need a real Postgres (CAS single-use, the (tenant,email) unique
// index, the role<>SUPER_ADMIN CHECK, cross-tenant scoping). Skips when the DB is unavailable.

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

// The inviter, as the principal the invite now records itself under (#400). `invitedById` used to be
// an argument and comes off this instead, so a caller can no longer attribute an invitation to
// somebody who never issued it.
const inviter = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: 9400n,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("invitation service (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  const pid = process.pid;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "InvA", slug: `inv-a-${pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "InvB", slug: `inv-b-${pid}` },
    });
    tenantB = b.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM invitations WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM users WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    // Clean any tenant created by the createTenant test (slug-prefixed).
    await suDb.$executeRawUnsafe(
      `DELETE FROM tenants WHERE slug LIKE 'inv-new-${pid}%'`,
    );
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("createInvite mints a hashed token (plaintext never stored)", async () => {
    const inv = await createInvite(
      inviter(tenantA),
      {
        tenantId: tenantA,
        email: "a1@x.com",
        role: "AGENT",
      },
      appDb,
    );
    expect(inv.token).toBeTruthy();
    const row = await suDb.invitation.findFirst({
      where: { tenantId: tenantA, email: "a1@x.com" },
    });
    expect(row?.tokenHash).toBeTruthy();
    expect(row?.tokenHash).not.toBe(inv.token);
  });

  test("createInvite refuses SUPER_ADMIN role", async () => {
    expect(
      createInvite(
        inviter(tenantA),
        {
          tenantId: tenantA,
          // biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard past the type.
          role: "SUPER_ADMIN" as any,
          email: "evil@x.com",
        },
        appDb,
      ),
    ).rejects.toBeInstanceOf(InviteInvalidError);
  });

  test("the DB CHECK also rejects a SUPER_ADMIN invitation row", async () => {
    // $executeRawUnsafe returns a (lazy) PrismaPromise, which bun's .rejects matcher does not
    // accept directly — await it inside try/catch instead.
    let threw = false;
    try {
      await suDb.$executeRawUnsafe(
        `INSERT INTO invitations (tenant_id, email, role, token_hash, expires_at, updated_at)
         VALUES (${tenantA}, 'chk@x.com', 'SUPER_ADMIN', 'h-${pid}', now() + interval '1 day', now())`,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("acceptInvite binds tenant+role from the row and is single-use", async () => {
    const inv = await createInvite(
      inviter(tenantA),
      {
        tenantId: tenantA,
        email: "join@x.com",
        role: "TENANT_ADMIN",
      },
      appDb,
    );
    const user = await acceptInvite(
      { token: inv.token, password: "supersecret", name: "Joiner" },
      appDb,
    );
    expect(user.tenantId).toBe(tenantA);
    expect(user.role).toBe("TENANT_ADMIN");
    expect(user.email).toBe("join@x.com");
    // Second accept of the same token → rejected (consumed).
    expect(
      acceptInvite({ token: inv.token, password: "supersecret" }, appDb),
    ).rejects.toBeInstanceOf(InviteInvalidError);
  });

  test("acceptInvite rejects an expired token generically", async () => {
    const inv = await createInvite(
      inviter(tenantA),
      {
        tenantId: tenantA,
        email: "old@x.com",
        role: "AGENT",
        ttlDays: -1,
      },
      appDb,
    );
    expect(findValidInviteByToken(inv.token, appDb)).resolves.toBeNull();
    expect(
      acceptInvite({ token: inv.token, password: "supersecret" }, appDb),
    ).rejects.toBeInstanceOf(InviteInvalidError);
  });

  test("createInvite refuses an email already in the tenant", async () => {
    await suDb.user.create({
      data: {
        tenantId: tenantA,
        email: "taken@x.com",
        passwordHash: "x",
        role: "AGENT",
      },
    });
    expect(
      createInvite(
        inviter(tenantA),
        {
          tenantId: tenantA,
          email: "taken@x.com",
          role: "AGENT",
        },
        appDb,
      ),
    ).rejects.toBeInstanceOf(InviteEmailInUseError);
  });

  test("listInvites + revokeInvite are tenant-scoped (no cross-tenant access)", async () => {
    const inv = await createInvite(
      inviter(tenantA),
      {
        tenantId: tenantA,
        email: "scoped@x.com",
        role: "AGENT",
      },
      appDb,
    );
    const aList = await listInvites(tenantA, appDb);
    expect(aList.some((i) => i.email === "scoped@x.com")).toBe(true);
    const bList = await listInvites(tenantB, appDb);
    expect(bList.some((i) => i.email === "scoped@x.com")).toBe(false);

    // tenant B cannot revoke tenant A's invite.
    expect(
      revokeInvite(inviter(tenantB), BigInt(inv.id), appDb),
    ).rejects.toBeInstanceOf(InviteNotFoundError);
    await revokeInvite(inviter(tenantA), BigInt(inv.id), appDb);
    const after = await listInvites(tenantA, appDb);
    expect(after.some((i) => i.email === "scoped@x.com")).toBe(false);
  });

  // NOTE: Full-only — createTenant is the paired tenants.admin.service, a ProEditionError stub in
  // Free, so this case can only fail there. It rides along in this file because it reuses the tenant
  // fixtures, not because provisioning is part of the invitation surface.
  // The three symbols are pulled in DYNAMICALLY, inside the block: as top-level imports they would
  // be left unused once Free strips the test, and marking the import region instead is not workable
  // — the blank line biome demands around it lands differently in each of the three trees.
});
