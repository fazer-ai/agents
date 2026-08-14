import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { emitOutbound } from "@/modules/webhooks/outbound/service";
import { isNewIncomingMessage } from "./normalize";
import type { NormalizedChatwootEvent } from "./types";

// Fire an outbound event from inside the mirror's scoped tx. Best-effort for the DOMAIN: a fan-out
// failure must never break the mirror write (it only enqueues rows the worker drains later), so we
// swallow + log. The data projection is allowlisted (ids/status only — no contact PII).
async function emitMirrorEvent(
  db: ScopedDb,
  tenantId: bigint,
  event: Parameters<typeof emitOutbound>[2],
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await emitOutbound(db, tenantId, event, data);
  } catch (err) {
    logger.warn(
      "outbound emit failed (event=%s): %s",
      event,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Mirror Chatwoot conversation/inbox/contact METADATA into our DB (no message body by default).
// Powers the UI conversation list + read API; the runtime reads it for routing. Contact and
// Inbox upserts are atomic (ON CONFLICT, safe under concurrency); the Conversation read-modify-
// write is serialized per conversation by an advisory lock and guarded monotonically so an
// out-of-order delivery (Chatwoot does not guarantee order) cannot regress status/assignee.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface MirrorResult {
  conversationRowId: bigint | null;
  // The assignee BEFORE this event applied — captured for the REENGAGE flow, which
  // must see the prior human assignee before the mirror overwrites it.
  prevAssigneeId: number | null;
  // The status BEFORE this event applied (null when there was no prior row). Lets a caller detect a
  // genuine transition (e.g. "just became resolved") without a second query — the channel-redirect
  // closing hook uses this to fire exactly once per resolve, even under a re-delivered webhook (the
  // second delivery sees prevStatus already equal to the new status, since the first already applied).
  prevStatus: string | null;
  applied: boolean; // false when skipped as a stale (out-of-order) event
  // Post-write metadata snapshot — the source of truth the caller broadcasts on the realtime
  // tenant channel (no PII; mirrors what the read API exposes). All null when there is no row.
  status: string | null;
  assigneeId: number | null;
  assigneeType: string | null;
  lastEventAt: Date | null;
}

export async function mirrorChatwootEvent(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  base: PrismaClient = basePrisma,
  // suppressInboundWatermark: the caller decides this is NOT genuine customer engagement (a control
  // command like /teste|/reset on a test-mode agent), so don't advance lastInboundAt — otherwise it
  // would look like a fresh reply and arm a follow-up / extend the 24h window. Mode is resolved by the
  // caller (the mirror is generic and runs before the gate).
  opts: { suppressInboundWatermark?: boolean } = {},
): Promise<MirrorResult> {
  if (n.conversationId === null) {
    return {
      conversationRowId: null,
      prevAssigneeId: null,
      prevStatus: null,
      applied: false,
      status: null,
      assigneeId: null,
      assigneeType: null,
      lastEventAt: null,
    };
  }
  const convId = n.conversationId;
  const newLastEventAt =
    n.lastActivityAt != null ? new Date(n.lastActivityAt * 1000) : null;
  // Version stamp of the conversation-level state this payload carries (see the state fence below).
  // Kept as the raw unix-seconds double Chatwoot sent: converting to Date would round to the
  // millisecond and collapse two writes that are microseconds apart into one version.
  const stateUpdatedAt = n.conversationUpdatedAt ?? null;
  // The inbound watermark (`lastInboundAt`) advances only on a brand-new incoming customer message
  // (message_created), never on a message_updated — our own STT/vision write-back re-dispatches one
  // and must not push it forward. The caller also suppresses it for a consumed control command (see
  // opts.suppressInboundWatermark). It anchors BOTH the follow-up "new episode" gate and the 24h
  // window.
  const inboundAt =
    isNewIncomingMessage(n) && !opts.suppressInboundWatermark
      ? (newLastEventAt ?? new Date())
      : null;

  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const contactId = await upsertContact(db, tenantId, n, newLastEventAt);
    const inboxRowId = await upsertInbox(db, tenantId, instanceId, n);

    const threadId = `${tenantId}:${instanceId}:${convId}`;
    return withEntityLock(db, threadId, async () => {
      const existing = await db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: convId,
          },
        },
        select: {
          id: true,
          lastEventAt: true,
          chatwootUpdatedAt: true,
          assigneeId: true,
          assigneeType: true,
          assigneeName: true,
          status: true,
        },
      });
      const prevAssigneeId = existing?.assigneeId ?? null;

      // Monotonic guard: only when both timestamps are known. A null new timestamp applies
      // best-effort (the next timestamped event reconciles).
      const stale =
        newLastEventAt != null &&
        existing?.lastEventAt != null &&
        existing.lastEventAt > newLastEventAt;
      if (stale) {
        return {
          conversationRowId: existing.id,
          prevAssigneeId,
          // No transition applied — report status/prevStatus equal so a caller's diff sees "no change".
          prevStatus: existing.status,
          applied: false,
          status: existing.status,
          assigneeId: existing.assigneeId,
          assigneeType: existing.assigneeType,
          lastEventAt: existing.lastEventAt,
        };
      }

      if (!existing) {
        const createdStatus = n.status ?? "open";
        const createdLastEventAt = newLastEventAt ?? new Date();
        const created = await db.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: convId,
            contactInboxId: n.contactInboxId,
            inboxId: inboxRowId,
            contactId,
            status: createdStatus,
            assigneeId: n.assigneeId ?? null,
            assigneeType: n.assigneeType ?? null,
            assigneeName: n.assigneeName ?? null,
            threadId,
            lastEventAt: createdLastEventAt,
            chatwootUpdatedAt: stateUpdatedAt,
            lastInboundAt: inboundAt,
            ...(n.customAttributes
              ? {
                  customAttributes: n.customAttributes as Prisma.InputJsonValue,
                }
              : {}),
            ...(n.kanbanAttributes
              ? {
                  kanbanAttributes: n.kanbanAttributes as Prisma.InputJsonValue,
                }
              : {}),
          },
          select: { id: true },
        });
        await emitMirrorEvent(db, tenantId, "conversation.created", {
          conversation_id: String(created.id),
          inbox_id: inboxRowId != null ? String(inboxRowId) : null,
          status: createdStatus,
          assignee_type: n.assigneeType ?? null,
        });
        return {
          conversationRowId: created.id,
          prevAssigneeId,
          // No prior row → no prior status (never a "transition" for a brand-new conversation).
          prevStatus: null,
          applied: true,
          status: createdStatus,
          assigneeId: n.assigneeId ?? null,
          assigneeType: n.assigneeType ?? null,
          lastEventAt: createdLastEventAt,
        };
      }

      const updatedLastEventAt = newLastEventAt ?? new Date();
      // NOTE: A MESSAGE event's conversation snapshot is serialized when the message event fires
      // (AgentBotListener builds the payload and only then enqueues it; a failed delivery retries
      // with that same copy), so it describes the conversation as of THAT moment, not the delivery's.
      // handoff_to_human posts its message BEFORE assigning the human, so the tail of every handoff
      // burst carries the pre-handoff state and used to rewrite the row back to it (issue #61).
      //
      // The guard above cannot order that: `last_activity_at` has one-second resolution and does not
      // advance on a status or assignee change at all, so a whole burst shares one value. The
      // conversation's `updated_at` can: it is the source row's version stamp, it moves on every
      // write to it (the status and assignee changes included), it has sub-second resolution, and it
      // is serialized together with the state it describes. Ordering conversation-level state by it
      // is exactly the finer-resolution tiebreaker the issue asks for, and Chatwoot already ships it.
      //
      // Ordering also settles the two cases a blanket "message events are never authoritative" rule
      // gets wrong, both of which carry state nothing else will resend: Chatwoot reopens BEFORE it
      // dispatches the message event (Message#execute_after_create_commit_callbacks runs
      // reopen_conversation, then dispatch_create_events), and a message a human sends after a
      // handoff is the only witness of the new assignee while the handoff's own event is in flight.
      //
      // Two ways to have no version to compare against, and they are NOT the same:
      //   * the payload carries none — a Chatwoot older than 4.0.2, where no payload ever will.
      //     There is no ordering to be had, so fall back to distrusting message snapshots, minus
      //     the brand-new incoming message whose reopen would otherwise be lost.
      //   * the payload carries one but the ROW does not — a conversation mirrored before this
      //     column existed. Only our history is missing: the payload's version is the first thing
      //     we know about this row, so take it and let ordering run from there. Delivery is
      //     bounded (AgentBots::WebhookJob retries 3× at 3s), so the only snapshot this can
      //     mis-trust is one that straddles the deploy itself.
      //
      // NOTE: `>=`, not `>`. An equal version is the same conversation row, so re-applying it is
      // idempotent — while REJECTING it is not: Chatwoot emits several events for one write
      // (conversation_updated + conversation_status_changed), and the one that arrives second is
      // frequently the one carrying `meta`. Under `>` the first delivery would win and its
      // companion's assignee would be dropped, which is the failure this fence exists to stop.
      // NOTE: A payload that says nothing about the assignee (`meta` absent — the degraded shape
      // behind issue #27) is not a description of the conversation, so it neither applies state nor
      // claims to be the version we hold. Advancing the watermark from it would be the worse half:
      // it would then outrank a complete payload that arrives late with the assignment.
      const describesState = n.assigneeType !== undefined;
      const applyState =
        describesState &&
        (stateUpdatedAt != null
          ? existing.chatwootUpdatedAt == null ||
            stateUpdatedAt >= existing.chatwootUpdatedAt
          : n.message === undefined || isNewIncomingMessage(n));
      const appliedStatus = applyState ? n.status : null;
      const nextStatus = appliedStatus ?? existing.status;
      // NOTE: The assignee trio travels together and applies only when BOTH hold: the payload
      // actually spoke about the assignee (`meta` present — undefined means "said nothing", and a
      // degraded event must NOT wipe a stored 'AgentBot'/'User', the intermittent self-wipe behind
      // issue #27) AND the snapshot is newer than the state we already have, per the fence above.
      const assigneeKnown = n.assigneeType !== undefined && applyState;
      const nextAssigneeId = assigneeKnown
        ? (n.assigneeId ?? null)
        : existing.assigneeId;
      const nextAssigneeType = assigneeKnown
        ? (n.assigneeType ?? null)
        : existing.assigneeType;
      await db.conversation.update({
        where: { id: existing.id },
        data: {
          ...(n.contactInboxId != null
            ? { contactInboxId: n.contactInboxId }
            : {}),
          ...(inboxRowId != null ? { inboxId: inboxRowId } : {}),
          ...(contactId != null ? { contactId } : {}),
          ...(appliedStatus != null ? { status: appliedStatus } : {}),
          ...(assigneeKnown
            ? {
                assigneeId: n.assigneeId ?? null,
                assigneeType: n.assigneeType ?? null,
                assigneeName: n.assigneeName ?? null,
              }
            : {}),
          lastEventAt: updatedLastEventAt,
          // NOTE: The watermark only moves forward. An equal version was applied just above but is
          // not news, and a strictly older one was rejected, so neither may rewrite it.
          ...(describesState &&
          stateUpdatedAt != null &&
          (existing.chatwootUpdatedAt == null ||
            stateUpdatedAt > existing.chatwootUpdatedAt)
            ? { chatwootUpdatedAt: stateUpdatedAt }
            : {}),
          ...(inboundAt != null ? { lastInboundAt: inboundAt } : {}),
          // NOTE: Attribute bags are ASSIGNED (the payload always ships the whole jsonb), but only
          // when the event carried one — a payload without them must not wipe the stored snapshot.
          // No watermark needed here: this runs inside the per-conversation lock, past the stale
          // check, so a late delivery never reaches it.
          ...(n.customAttributes
            ? { customAttributes: n.customAttributes as Prisma.InputJsonValue }
            : {}),
          ...(n.kanbanAttributes
            ? { kanbanAttributes: n.kanbanAttributes as Prisma.InputJsonValue }
            : {}),
        },
      });
      const inboxIdStr = inboxRowId != null ? String(inboxRowId) : null;
      if (appliedStatus != null && appliedStatus !== existing.status) {
        await emitMirrorEvent(db, tenantId, "conversation.status_changed", {
          conversation_id: String(existing.id),
          inbox_id: inboxIdStr,
          status: nextStatus,
          previous_status: existing.status,
          assignee_type: nextAssigneeType,
        });
      }
      // Handoff = the assignee transitions to a human (User). Detect the bot→human edge:
      // prior assignee type was not User and the new one is User. A snapshot older than the state
      // we hold never fires it — its assignee was not applied above. (An undefined trio — degraded
      // payload — never equals "User" either, so it can neither fire nor mask the edge.)
      if (
        applyState &&
        existing.assigneeType !== "User" &&
        n.assigneeType === "User"
      ) {
        await emitMirrorEvent(db, tenantId, "conversation.handoff", {
          conversation_id: String(existing.id),
          inbox_id: inboxIdStr,
        });
      }
      return {
        conversationRowId: existing.id,
        prevAssigneeId,
        // The status as persisted BEFORE this update — the real transition source value.
        prevStatus: existing.status,
        applied: true,
        status: nextStatus,
        // EFFECTIVE values (what is stored after this update), not the payload's silence.
        assigneeId: nextAssigneeId,
        assigneeType: nextAssigneeType,
        lastEventAt: updatedLastEventAt,
      };
    });
  });
}

async function upsertContact(
  db: ScopedDb,
  tenantId: bigint,
  n: NormalizedChatwootEvent,
  eventAt: Date | null,
): Promise<bigint | null> {
  const c = n.contact;
  if (!c || c.id == null) return null;
  const attributes = (
    c.identifier ? { identifier: c.identifier } : {}
  ) as Prisma.InputJsonValue;
  const row = await db.contact.upsert({
    where: {
      tenantId_chatwootContactId: { tenantId, chatwootContactId: c.id },
    },
    create: {
      tenantId,
      chatwootContactId: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      attributes,
    },
    update: {
      ...(c.name != null ? { name: c.name } : {}),
      ...(c.email != null ? { email: c.email } : {}),
      ...(c.phone != null ? { phone: c.phone } : {}),
    },
    select: { id: true },
  });
  // NOTE: Chatwoot ships the contact's whole custom_attributes hash on every event, so it is
  // assigned wholesale — but only when this payload carried it (absent ⇒ keep the stored snapshot),
  // and only when it is NEWER than what produced the stored one. This upsert runs before the
  // conversation's stale check (the conversation row needs the contact id), and one contact is
  // shared by all its conversations, so the conversation guard cannot cover it: the watermark is
  // per-contact. Single statement ⇒ the compare-and-set is atomic under concurrent deliveries.
  //
  // `custom_attributes_at` is a SOURCE position, never a receipt time: stamping an undated payload
  // with our own clock would make it beat every real Chatwoot timestamp and poison the ordering. An
  // undated payload therefore only BOOTSTRAPS a contact nothing has positioned yet, and leaves the
  // watermark null so the first dated event still takes over.
  if (c.customAttributes) {
    const bag = JSON.stringify(c.customAttributes);
    await (eventAt
      ? db.$executeRaw`
          UPDATE contacts
          SET custom_attributes = ${bag}::jsonb, custom_attributes_at = ${eventAt}
          WHERE id = ${row.id} AND tenant_id = ${tenantId}
            AND (custom_attributes_at IS NULL OR custom_attributes_at <= ${eventAt})
        `
      : db.$executeRaw`
          UPDATE contacts
          SET custom_attributes = ${bag}::jsonb
          WHERE id = ${row.id} AND tenant_id = ${tenantId}
            AND custom_attributes_at IS NULL
        `);
  }
  return row.id;
}

async function upsertInbox(
  db: ScopedDb,
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
): Promise<bigint | null> {
  if (n.inboxId == null) return null;
  const row = await db.inbox.upsert({
    where: {
      tenantId_chatwootInstanceId_chatwootInboxId: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: n.inboxId,
      },
    },
    create: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootInboxId: n.inboxId,
      name: n.inboxName ?? `inbox ${n.inboxId}`,
      channelType: n.channel ?? null,
    },
    update: {
      ...(n.inboxName != null ? { name: n.inboxName } : {}),
      ...(n.channel != null ? { channelType: n.channel } : {}),
    },
    select: { id: true },
  });
  return row.id;
}
