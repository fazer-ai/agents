import { Prisma } from "@/../generated/prisma/client";
import { dedupeKeyStartsWith } from "@/modules/scheduler/service";

// Every APPOINTMENT_REMINDER key starts here: `reminder:<provider-scoped event id>:<offset hours>`.
export const REMINDER_KEY_ROOT = "reminder:";

// A conversation's PENDING reminders, soonest first, for its detail page. The key carries the event and
// not the thread, so the read is the tenant's reminders by key root (an index range under the tenant
// policy, `dedupeKeyStartsWith`) and the thread is matched on the payload of those alone.
export function threadRemindersSql(
  tenantId: bigint,
  threadId: string,
): Prisma.Sql {
  return Prisma.sql`
    SELECT run_at AS "runAt", payload
      FROM scheduler_jobs
     WHERE tenant_id = ${tenantId}
       AND ${dedupeKeyStartsWith(REMINDER_KEY_ROOT)}
       AND kind = 'APPOINTMENT_REMINDER' AND status = 'PENDING'
       AND payload->>'threadId' = ${threadId}
     ORDER BY run_at
     LIMIT 20`;
}
