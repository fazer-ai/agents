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

// How old a message a reader that a webhook or a cursor brings back may ask the ledger about: a day
// inside the retention, so the rows its delivery wrote are still there (a row's receipt follows the
// message's creation, give or take the clocks of two hosts). A job holds its own row instead, for as
// long as it is live (`ledgerRetentionBatch`).
export const LEDGER_READ_HORIZON_MS = LEDGER_RETENTION_MS - 24 * 60 * 60 * 1000;

// The reconcile's floor.
export const RECONCILE_MAX_LOOKBACK_MS = LEDGER_READ_HORIZON_MS;

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

// Where a tenant's pass stands in its range: the last row a page examined, in `(received_at, id)`
// order. In process, so a restart begins again from the oldest row, which costs pages, not rows.
export type LedgerCursor = { at: Date; id: bigint } | null;
const cursors = new Map<string, NonNullable<LedgerCursor>>();

/** Test-only: forget where each tenant's pass stands. */
export function forgetLedgerCursorsForTest(): void {
  cursors.clear();
}

// One page of the retention pass (src/modules/flowlog/retention.ts): the next `rows` rows of the
// tenant's range past the cutoff, in `(received_at, id)` order after `after`, of which the settled ones
// no live job still reads are deleted. The page bounds the rows EXAMINED, so a range of rows the pass
// must keep is walked a page at a time instead of in one statement. The range runs on
// `(tenant_id, received_at)` with the tenant named, timestamps and bigint compare leakproof under RLS.
// A row a live job still reads stays: its delivery, takeover or reply recovery by the row's key, the
// deliveries of a message its ingest fallback counts, and the siblings a reply recovery's coverage
// question reads (docs/chatwoot.md, "Ledger retention").
export function ledgerRetentionPage(
  tenantId: bigint,
  rows: number,
  cutoffs: { processed: Date; dead: Date },
  after: LedgerCursor,
): Prisma.Sql {
  const from = after
    ? Prisma.sql`AND d.received_at >= ${after.at}
          AND (d.received_at > ${after.at} OR d.id > ${after.id})`
    : Prisma.empty;
  return Prisma.sql`
    WITH page AS MATERIALIZED (
      SELECT d.id, d.received_at, d.status::text AS status, d.processed_at,
             d.chatwoot_instance_id, d.conversation_id, d.inbound_message_id,
             d.human_reply_message_id
        FROM chatwoot_webhook_deliveries d
       WHERE d.tenant_id = ${tenantId} AND d.received_at < ${cutoffs.processed}
         ${from}
       ORDER BY d.received_at, d.id
       LIMIT ${rows}),
    -- The live ingest fallbacks and reply recoveries, read once per page by key prefix (starts_with is
    -- leakproof and a range on the key index under the policy). Payload fields compare as text, so one
    -- no job could parse holds nothing rather than failing the page.
    fallbacks AS MATERIALIZED (
      SELECT j.payload->>'instanceId' AS instance_id,
             j.payload->>'conversationId' AS conversation_id,
             j.payload->>'messageId' AS message_id
        FROM scheduler_jobs j
       WHERE j.tenant_id = ${tenantId}
         AND starts_with(j.dedupe_key, 'ingest-fallback:')
         AND j.status IN ('PENDING', 'CLAIMED')),
    replies AS MATERIALIZED (
      SELECT CASE WHEN j.payload->>'deliveryRowId' ~ '^[0-9]{1,18}$'
                  THEN (j.payload->>'deliveryRowId')::bigint END AS row_id
        FROM scheduler_jobs j
       WHERE j.tenant_id = ${tenantId}
         AND starts_with(j.dedupe_key, 'human-reply-recovery:')
         AND j.status IN ('PENDING', 'CLAIMED')),
    -- Each recovery's own row by primary key, one probe per live job.
    replied AS MATERIALIZED (
      SELECT r.chatwoot_instance_id, r.conversation_id, r.human_reply_message_id
        FROM replies x
        CROSS JOIN LATERAL (
          SELECT r.chatwoot_instance_id, r.conversation_id, r.human_reply_message_id
            FROM chatwoot_webhook_deliveries r
           WHERE r.tenant_id = ${tenantId} AND r.id = x.row_id
             AND r.human_reply_message_id IS NOT NULL
          OFFSET 0) r),
    gone AS (
      DELETE FROM chatwoot_webhook_deliveries WHERE id = ANY(ARRAY(
        SELECT p.id FROM page p
          -- The recovery keys, built beside the row and compared bare below: built inside the lookup
          -- they are a leaky expression over an outer reference, which PostgreSQL 17.12 keeps above
          -- the tenant policy as a Filter (docs/tenancy.md). OFFSET 0 keeps them from folding back in.
          CROSS JOIN LATERAL (
            SELECT 'delivery-recovery:' || p.id AS delivery,
                   'takeover-recovery:' || p.id AS takeover,
                   'human-reply-recovery:' || p.id AS reply
            OFFSET 0
          ) k
         WHERE ((p.status = 'PROCESSED'
                 AND COALESCE(p.processed_at, p.received_at) < ${cutoffs.processed})
             OR (p.status = 'DEAD'
                 AND COALESCE(p.processed_at, p.received_at) < ${cutoffs.dead}))
           AND NOT EXISTS (
                 SELECT 1 FROM scheduler_jobs j
                  WHERE j.tenant_id = ${tenantId}
                    AND j.dedupe_key IN (k.delivery, k.takeover, k.reply)
                    AND j.status IN ('PENDING', 'CLAIMED')
                 -- A probe per row by key, never an anti join: under the policy the status filter
                 -- does not narrow the estimate, and joined the lookup reaches the index by tenant alone.
                 OFFSET 0)
           AND NOT EXISTS (
                 SELECT 1 FROM fallbacks f
                  WHERE f.instance_id = p.chatwoot_instance_id::text
                    AND f.conversation_id = p.conversation_id::text
                    AND f.message_id = p.inbound_message_id::text)
           AND NOT EXISTS (
                 SELECT 1 FROM replied h
                  WHERE h.chatwoot_instance_id = p.chatwoot_instance_id
                    AND h.conversation_id = p.conversation_id
                    AND h.human_reply_message_id = p.human_reply_message_id)))
      RETURNING 1)
    SELECT (SELECT count(*) FROM page)::int AS examined,
           (SELECT count(*) FROM gone)::int AS deleted,
           l.received_at AS "lastAt", l.id AS "lastId"
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
        SELECT received_at, id FROM page ORDER BY received_at DESC, id DESC LIMIT 1) l ON true`;
}

// Runs one page from where the tenant's pass stands, and moves it on: past the page when the page was
// full, back to the start when the range ran out, so the next sweep walks it again from the oldest.
export async function ledgerRetentionStep(
  db: { $queryRaw: (sql: Prisma.Sql) => Promise<unknown> },
  tenantId: bigint,
  rows: number,
  cutoffs: { processed: Date; dead: Date },
): Promise<{ examined: number; deleted: number }> {
  const key = String(tenantId);
  const [r] = (await db.$queryRaw(
    ledgerRetentionPage(tenantId, rows, cutoffs, cursors.get(key) ?? null),
  )) as {
    examined: number;
    deleted: number;
    lastAt: Date | null;
    lastId: bigint | null;
  }[];
  if (!r) throw new Error("ledger retention: the page returned no row");
  if (r.examined < rows || r.lastAt === null || r.lastId === null)
    cursors.delete(key);
  else cursors.set(key, { at: r.lastAt, id: r.lastId });
  return { examined: r.examined, deleted: r.deleted };
}
