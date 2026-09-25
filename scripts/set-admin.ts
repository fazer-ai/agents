#!/usr/bin/env bun

import { PrismaPg } from "@prisma/adapter-pg";
import { emailEquals } from "@/lib/email-match";
import { roleAtLeast } from "@/lib/roles";
import { PrismaClient, type UserRole } from "../generated/prisma/client";

export interface ExistingUserUpdatePlan {
  // Present only when a promotion is actually needed (the role the person holds where it counts is
  // below target). Role and tenant travel TOGETHER because they are one fact (issue #756):
  // SUPER_ADMIN is the person, with no tenant, and any other role is a membership in `tenantId`.
  promotion?: { role: UserRole; tenantId: bigint | null };
  passwordHash?: string;
  message: string;
}

// Pure decision logic for updating an EXISTING user (no DB/hashing I/O), so the "never
// silently demote, never split role from tenant" rule is unit-testable. Setting a password
// must NOT force a role change: a SUPER_ADMIN given a password used to get unconditionally
// reset to the computed TENANT_ADMIN role. Promotion only happens when the user's current role
// ranks below the target. `currentRole` is SUPER_ADMIN for a fleet administrator, the role held in
// the target tenant otherwise, and null when the person does not belong to it yet.
export function planExistingUserUpdate(params: {
  email: string;
  currentRole: UserRole | null;
  targetRole: UserRole;
  targetTenantId: bigint | null;
  targetRoleLabel: string;
  passwordHash?: string;
}): ExistingUserUpdatePlan {
  const { email, currentRole, targetRole, targetTenantId, targetRoleLabel } =
    params;
  const needsPromotion =
    currentRole === null || !roleAtLeast(currentRole, targetRole);
  const promotion = needsPromotion
    ? { role: targetRole, tenantId: targetTenantId }
    : undefined;

  if (!needsPromotion && !params.passwordHash) {
    return {
      message: `User ${email} is already at or above ${targetRole} (${currentRole ?? "no membership"}).`,
    };
  }

  const message =
    needsPromotion && params.passwordHash
      ? `User ${email} set as ${targetRoleLabel} with new password.`
      : needsPromotion
        ? `Successfully set ${email} as ${targetRoleLabel}.`
        : `Password updated for ${email} (role unchanged: ${currentRole ?? "no membership"}).`;

  return { promotion, passwordHash: params.passwordHash, message };
}

async function main() {
  const email = process.argv[2];
  const passwordArg = process.argv[3];

  if (!email) {
    console.error("Usage: bun scripts/set-admin.ts <email> [password]");
    process.exit(1);
  }

  // NOTE: admin CLI connects via the migration/superuser URL so it can read the tenants
  // table and write users without RLS friction (it writes outside the /setup advisory lock).
  // Run via Bun, which expands ${POSTGRES_PORT} in .env at load time.
  const databaseUrl =
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "MIGRATION_DATABASE_URL or DATABASE_URL environment variable is required",
    );
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    // NOTE: TENANT_ADMIN of the first tenant when one exists; SUPER_ADMIN (no membership)
    // otherwise, so this can also bootstrap a fleet admin before /setup has run.
    const tenant = await prisma.tenant.findFirst({
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const role: UserRole = tenant ? "TENANT_ADMIN" : "SUPER_ADMIN";
    const tenantId = tenant?.id ?? null;
    const roleLabel = `${role}${tenant ? ` (tenant ${tenant.id})` : ""}`;

    const user = await prisma.user.findFirst({
      where: { email: emailEquals(email) },
      select: {
        id: true,
        isSuperAdmin: true,
        memberships: {
          where: { tenantId: tenantId ?? -1n },
          select: { role: true },
        },
      },
    });

    if (!user) {
      const password =
        passwordArg ??
        crypto.randomUUID().replace(/-/g, "") +
          crypto.randomUUID().replace(/-/g, "").toUpperCase();
      const passwordHash = await Bun.password.hash(password, {
        algorithm: "bcrypt",
        cost: 10,
      });

      await prisma.user.create({
        data: {
          email,
          passwordHash,
          isSuperAdmin: tenantId === null,
          ...(tenantId === null
            ? {}
            : { memberships: { create: { tenantId, role } } }),
        },
      });

      console.log(`User created and set as ${roleLabel}.`);
      console.log(`Email:    ${email}`);
      if (!passwordArg) console.log(`Password: ${password}`);
      return;
    }

    const passwordHash = passwordArg
      ? await Bun.password.hash(passwordArg, { algorithm: "bcrypt", cost: 10 })
      : undefined;

    const plan = planExistingUserUpdate({
      email,
      currentRole: user.isSuperAdmin
        ? "SUPER_ADMIN"
        : (user.memberships[0]?.role ?? null),
      targetRole: role,
      targetTenantId: tenantId,
      targetRoleLabel: roleLabel,
      passwordHash,
    });

    const promotion = plan.promotion;
    if (promotion || plan.passwordHash) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          ...(promotion?.tenantId === null ? { isSuperAdmin: true } : {}),
          ...(plan.passwordHash ? { passwordHash: plan.passwordHash } : {}),
        },
      });
    }
    if (promotion && promotion.tenantId !== null) {
      await prisma.tenantUser.upsert({
        where: {
          tenantId_userId: { tenantId: promotion.tenantId, userId: user.id },
        },
        create: {
          tenantId: promotion.tenantId,
          userId: user.id,
          role: promotion.role,
        },
        update: { role: promotion.role },
      });
    }

    console.log(plan.message);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
  });
}
