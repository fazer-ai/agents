import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Where the CURRENT attendance starts, as memory compaction cut the contact's thread, for a reader
// outside it (carrying the customer's files into a case, ../cross-inbox-case). Compaction cuts the
// contact-inbox's thread, not one conversation: a cut can fold several conversations into one row
// named after the newest of them. So the boundary is the newest dated cut of the whole thread, and
// no dated cut means everything is still the first attendance. An undated row (the mirrored
// conversation was gone when it was cut) says nothing about where, and is passed over.
export async function attendanceStartedAt(
  base: PrismaClient,
  p: {
    tenantId: bigint;
    instanceId: bigint;
    contactInboxId: number;
  },
): Promise<Date | null> {
  const row = await runScopedOn(base, sysCtx(p.tenantId), (db) =>
    db.attendanceSummary.findFirst({
      where: {
        tenantId: p.tenantId,
        chatwootInstanceId: p.instanceId,
        contactInboxId: p.contactInboxId,
        attendanceAt: { not: null },
      },
      orderBy: { attendanceAt: "desc" },
      select: { attendanceAt: true },
    }),
  );
  return row?.attendanceAt ?? null;
}
