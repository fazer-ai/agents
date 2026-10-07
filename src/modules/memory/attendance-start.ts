import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Where the CURRENT attendance of a conversation starts, as memory compaction cut it, for a reader
// outside the thread (carrying the customer's files into a case, ../cross-inbox-case). A conversation
// becomes several attendances only by being resolved, compacted and reopened: each pass leaves a
// summary row for that conversation, dated by the conversation's last event when it was cut. So the
// newest row's date is where the open attendance begins, and no row means the whole conversation is
// still the first one. A row with no date (the mirrored conversation was gone when it was cut) says
// nothing about where, and reads as no boundary.
export async function attendanceStartedAt(
  base: PrismaClient,
  p: {
    tenantId: bigint;
    instanceId: bigint;
    contactInboxId: number;
    conversationId: number;
  },
): Promise<Date | null> {
  const row = await runScopedOn(base, sysCtx(p.tenantId), (db) =>
    db.attendanceSummary.findFirst({
      where: {
        tenantId: p.tenantId,
        chatwootInstanceId: p.instanceId,
        contactInboxId: p.contactInboxId,
        conversationId: p.conversationId,
      },
      orderBy: { id: "desc" },
      select: { attendanceAt: true },
    }),
  );
  return row?.attendanceAt ?? null;
}
