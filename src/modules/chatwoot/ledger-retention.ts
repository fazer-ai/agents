import { Prisma } from "@/../generated/prisma/client";
import config from "@/config";

// How long a settled row of `chatwoot_webhook_deliveries` is kept. The longest any reader of the
// ledger reaches back is six hours (the delivery recovery's ceiling, the stored-body drain's and the
// reconcile's first pass, all `MAX_RECOVERY_AGE_MS`), and the reconcile, whose cursor can fall behind,
// never judges a message older than `RECONCILE_MAX_LOOKBACK_MS`. Seven days is that with a margin wide
// enough for an instance left off over a long weekend. A fixed constant and not an operator setting:
// no screen, route or tool reads the ledger, and the only number that bounds it is in the code. See
// docs/chatwoot.md, "Ledger retention".
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
// their cutoff, never a row still owed an attempt. The range runs on `(tenant_id, received_at)`, so the
// tenant is named here and not left to the policy, which under the fleet role names none, and the
// cutoffs are compared as timestamps: that comparison is leakproof and reaches the index under RLS,
// the status filter is not and is applied to what the range returns. Receipt is the clock: no writer
// reaches a row past the recovery's six hours, and the reconcile, which dates the rows it writes by
// the message, never writes one older than `RECONCILE_MAX_LOOKBACK_MS`.
export function ledgerRetentionBatch(
  tenantId: bigint,
  rows: number,
  cutoffs: { processed: Date; dead: Date },
): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM chatwoot_webhook_deliveries WHERE id = ANY(ARRAY(
      SELECT id FROM chatwoot_webhook_deliveries
       WHERE tenant_id = ${tenantId} AND received_at < ${cutoffs.processed}
         AND (status = 'PROCESSED'
           OR (status = 'DEAD' AND received_at < ${cutoffs.dead}))
       LIMIT ${rows}))`;
}
