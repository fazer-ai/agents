import { Prisma } from "@/../generated/prisma/client";
import config from "@/config";

// How long a settled row of `chatwoot_webhook_deliveries` is kept, counted from its receipt and from its
// settlement. The longest any reader reaches back is six hours from receipt (`MAX_RECOVERY_AGE_MS`) or
// a recovery's retries from settlement, and the reconcile, whose cursor can fall behind, never judges a
// message older than `RECONCILE_MAX_LOOKBACK_MS`. Seven days is that with a margin for an instance left
// off over a long weekend. A fixed constant and not an operator setting: no screen, route or tool reads
// the ledger, and the only number that bounds it is in the code. See docs/chatwoot.md, "Ledger
// retention".
export const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// The reconcile's floor: a day inside the retention, so a message it judges still has the row its
// delivery wrote (a row's receipt follows the message's creation, give or take the clocks of two hosts).
export const RECONCILE_MAX_LOOKBACK_MS =
  LEDGER_RETENTION_MS - 24 * 60 * 60 * 1000;

// The two cutoffs of the retention pass. A `PROCESSED` row goes at `LEDGER_RETENTION_MS`. A `DEAD` row
// is the customer nobody answered, and the error line that reports it lives in the flow log, so it stays
// as long as that line does, never less than a `PROCESSED` one.
export function ledgerRetentionCutoffs(now = Date.now()): {
  processed: Date;
  dead: Date;
} {
  const deadMs = Math.max(
    LEDGER_RETENTION_MS,
    config.flowlog.retentionDays * 86_400_000,
  );
  return {
    processed: new Date(now - LEDGER_RETENTION_MS),
    dead: new Date(now - deadMs),
  };
}

// One batch of the retention pass (src/modules/flowlog/retention.ts): up to `rows` settled rows past
// their cutoff, never a row still owed an attempt. The range runs on `(tenant_id, received_at)` with the
// tenant named here, since under the fleet role the policy names none, and timestamps are leakproof and
// reach the index under RLS while the status filter is applied to what the range returns. Settlement
// is a second clock because the stranded sweep settles a days-old row after an outage and arms a
// recovery with no age ceiling, and the reconcile dates its rows by the message. A row whose takeover
// or reply recovery is PENDING or CLAIMED stays at any age: that job reads it by id and, finding none,
// ends `not-owed` unrepaired (keys of `takeoverRecoveryDedupeKey`, `humanReplyRecoveryDedupeKey`).
export function ledgerRetentionBatch(
  tenantId: bigint,
  rows: number,
  cutoffs: { processed: Date; dead: Date },
): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM chatwoot_webhook_deliveries WHERE id = ANY(ARRAY(
      SELECT d.id FROM chatwoot_webhook_deliveries d
       WHERE tenant_id = ${tenantId} AND received_at < ${cutoffs.processed}
         AND ((status = 'PROCESSED'
               AND COALESCE(processed_at, received_at) < ${cutoffs.processed})
           OR (status = 'DEAD'
               AND COALESCE(processed_at, received_at) < ${cutoffs.dead}))
         AND NOT EXISTS (
               SELECT 1 FROM scheduler_jobs j
                WHERE j.tenant_id = ${tenantId}
                  AND j.dedupe_key IN ('takeover-recovery:' || d.id,
                                       'human-reply-recovery:' || d.id)
                  AND j.status IN ('PENDING', 'CLAIMED'))
       LIMIT ${rows}))`;
}
