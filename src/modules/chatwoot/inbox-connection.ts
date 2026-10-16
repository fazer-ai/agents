import type { ScopedDb } from "@/lib/tenancy";
import { emitOutbound } from "@/modules/webhooks/outbound/service";

// A WhatsApp session inbox's connection changing, as the Chatwoot fork reports it to every bot of the
// inbox (the responder and each observer, so the same change arrives once per route). docs/chatwoot.md,
// "Channel connection".
export const INBOX_CONNECTION_EVENT = "inbox_provider_connection_updated";

export interface InboxConnectionChange {
  chatwootInboxId: number;
  connection: string | null;
  previousConnection: string | null;
  provider: string | null;
  // The fork's own write time, ISO 8601 with microseconds, kept as text so Postgres compares it whole.
  changedAt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : undefined;
}

// Whether a parsed body is this event at all, before its shape is checked.
export function isInboxConnectionDelivery(payload: unknown): boolean {
  return isRecord(payload) && payload.event === INBOX_CONNECTION_EVENT;
}

// Null for a body that does not have the shape: no inbox id, no parseable `changed_at`, or a
// connection that is not a string. Absent `connection` is a teardown and reads as null.
export function parseInboxConnectionChange(
  payload: unknown,
): InboxConnectionChange | null {
  if (!isRecord(payload) || payload.event !== INBOX_CONNECTION_EVENT)
    return null;
  const inbox = isRecord(payload.inbox) ? payload.inbox : null;
  const chatwootInboxId = inbox?.id;
  if (
    typeof chatwootInboxId !== "number" ||
    !Number.isSafeInteger(chatwootInboxId) ||
    chatwootInboxId <= 0
  )
    return null;
  const changedAt = payload.changed_at;
  if (typeof changedAt !== "string" || Number.isNaN(Date.parse(changedAt)))
    return null;
  const state = isRecord(payload.provider_connection)
    ? payload.provider_connection
    : null;
  if (!state) return null;
  const connection = optionalString(state.connection);
  const previousConnection = optionalString(payload.previous_connection);
  const provider = optionalString(inbox?.provider);
  if (
    connection === undefined ||
    previousConnection === undefined ||
    provider === undefined
  )
    return null;
  return {
    chatwootInboxId,
    connection,
    previousConnection,
    provider,
    changedAt,
  };
}

export type InboxConnectionOutcome =
  | "emitted"
  | "applied"
  | "stale"
  | "unknown_inbox";

// Stores the change when it is newer than what the inbox holds and announces the edge it makes: into
// `open` is `channel.connected`, out of `open` is `channel.disconnected`, and a move between two other
// states is stored without an event. The edge is taken from the stored state when there is one, and
// from the fork's `previous_connection` only for the first report, so a change missed in between still
// yields the edge a subscriber has not seen. A report at or before the stored time is a repeat (the
// other route's copy, a redelivery) or an older change arriving late, and does nothing. Runs in the
// caller's transaction: a failed emit rolls the stored state back with it, so the retry announces.
export async function applyInboxConnectionChange(
  db: ScopedDb,
  tenantId: bigint,
  instanceId: bigint,
  change: InboxConnectionChange,
): Promise<InboxConnectionOutcome> {
  const rows = await db.$queryRaw<
    { id: bigint; connection: string | null; known: boolean; stale: boolean }[]
  >`
    SELECT id,
           provider_connection AS connection,
           provider_connection_at IS NOT NULL AS known,
           COALESCE(provider_connection_at >= ${change.changedAt}::timestamptz, false) AS stale
      FROM inboxes
     WHERE tenant_id = ${tenantId}
       AND chatwoot_instance_id = ${instanceId}
       AND chatwoot_inbox_id = ${change.chatwootInboxId}
       FOR NO KEY UPDATE`;
  const row = rows[0];
  if (!row) return "unknown_inbox";
  if (row.stale) return "stale";

  await db.$executeRaw`
    UPDATE inboxes
       SET provider_connection = ${change.connection},
           provider_connection_at = ${change.changedAt}::timestamptz
     WHERE id = ${row.id}`;

  const before = row.known ? row.connection : change.previousConnection;
  const wasOpen = before === "open";
  const isOpen = change.connection === "open";
  if (wasOpen === isOpen) return "applied";

  await emitOutbound(
    db,
    tenantId,
    isOpen ? "channel.connected" : "channel.disconnected",
    {
      inbox_id: String(row.id),
      chatwoot_inbox_id: String(change.chatwootInboxId),
      provider: change.provider,
      connection: change.connection,
      previous_connection: before,
      changed_at: change.changedAt,
    },
  );
  return "emitted";
}
