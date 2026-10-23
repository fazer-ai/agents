import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type OccurrencesConfig, readOccurrencesConfig } from "./settings";

export function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The account's monitor as the runtime reads it: lenient, so a damaged block is OFF.
export async function readTenantOccurrences(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<OccurrencesConfig> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    }),
  );
  return readOccurrencesConfig(row?.settings ?? {});
}
