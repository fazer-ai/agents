import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { clearsResolutionOrigin } from "@/modules/conversations/resolution-origin";
import { emitOutbound } from "@/modules/webhooks/outbound/service";
import { isNewIncomingMessage } from "./normalize";
import { decideConversationWrites, type StatePayload } from "./state-order";
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
// write is serialized per conversation by an advisory lock, and what each delivery is allowed to
// write is decided by `state-order.ts` (Chatwoot does not guarantee order, and a message event
// carries a frozen conversation snapshot that must not regress status/assignee).

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
  const now = new Date();
  const newLastEventAt =
    n.lastActivityAt != null ? new Date(n.lastActivityAt * 1000) : null;
  // How this payload is positioned against what we already store. The rules, and the Chatwoot
  // behaviour they are written against, live in `state-order.ts`.
  const statePayload: StatePayload = {
    version: n.conversationUpdatedAt ?? null,
    activityAt: newLastEventAt,
    fromConversationEvent: n.message === undefined,
    reopensConversation: isNewIncomingMessage(n),
    status: n.status ?? null,
    assigneeStated: n.assigneeType !== undefined,
    assigneeType: n.assigneeType ?? null,
  };
  // The inbound watermark (`lastInboundAt`) advances only on a brand-new incoming customer message
  // (message_created), never on a message_updated — our own STT/vision write-back re-dispatches one
  // and must not push it forward. The caller also suppresses it for a consumed control command (see
  // opts.suppressInboundWatermark). It anchors BOTH the follow-up "new episode" gate and the 24h
  // window.
  const inboundAt =
    isNewIncomingMessage(n) && !opts.suppressInboundWatermark
      ? (newLastEventAt ?? now)
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
          chatwootStatusAt: true,
          chatwootAssigneeAt: true,
          assigneeId: true,
          assigneeType: true,
          assigneeName: true,
          status: true,
          resolvedBy: true,
          resolvedByAt: true,
        },
      });
      const prevAssigneeId = existing?.assigneeId ?? null;
      const decision = decideConversationWrites(
        statePayload,
        existing
          ? {
              activityAt: existing.lastEventAt,
              statusAt: existing.chatwootStatusAt,
              assigneeAt: existing.chatwootAssigneeAt,
              assigneeType: existing.assigneeType,
            }
          : null,
        now,
      );
      // Whether this event kills a recorded resolution origin, asked ONCE for both exits below: the
      // stale branch returns before the update, and rounds 5 and 6 of this change were the same rule
      // stated twice and getting a different axis wrong each time. The rule itself, and why it takes
      // these three facts and not `decision.stale`, is in `clearsResolutionOrigin`.
      const dropsResolutionOrigin =
        existing != null &&
        clearsResolutionOrigin({
          storedStatus: existing.status,
          statedStatus: statePayload.status,
          appliedStatus: decision.status,
          // NOTE: Exactly what the flag means: a conversation event speaks about status, a message
          // snapshot embeds one but is meant to move no state (issue #61). NOT `&& version != null`:
          // `decideConversationWrites` orders a versionless conversation event by `last_activity_at`
          // and lets it move status, so requiring a version silently exempted every Chatwoot older
          // than 4.0.2 from the rule below.
          sourceMayStateStatus: statePayload.fromConversationEvent,
          reopens: statePayload.reopensConversation,
          statedVersion: statePayload.version,
          stampedAfterVersion: existing.resolvedByAt,
        });

      if (existing && decision.stale) {
        // NOTE: A stale event says nothing about the conversation, with ONE exception: a close of ours
        // that this ordering refused. Written here because this branch returns before the update.
        // `resolvedBy != null` is a write-avoidance guard, not part of the rule: this branch is
        // taken by every out-of-order delivery, and clearing a column that is already null would
        // add an UPDATE to each one.
        if (dropsResolutionOrigin && existing.resolvedBy != null) {
          await db.conversation.update({
            where: { id: existing.id },
            data: { resolvedBy: null, resolvedByAt: null },
          });
        }
        return {
          conversationRowId: existing.id,
          prevAssigneeId,
          // NOTE: No transition applied — report status/prevStatus equal so a caller's diff sees "no change".
          prevStatus: existing.status,
          applied: false,
          status: existing.status,
          assigneeId: existing.assigneeId,
          assigneeType: existing.assigneeType,
          lastEventAt: existing.lastEventAt,
        };
      }

      if (!existing) {
        const createdStatus = decision.status ?? "open";
        const createdLastEventAt = decision.activityAt;
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
            chatwootStatusAt: decision.statusAt,
            chatwootAssigneeAt: decision.assigneeAt,
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
          // NOTE: No prior row → no prior status (never a "transition" for a brand-new conversation).
          prevStatus: null,
          applied: true,
          status: createdStatus,
          assigneeId: n.assigneeId ?? null,
          assigneeType: n.assigneeType ?? null,
          lastEventAt: createdLastEventAt,
        };
      }

      const effectiveLastEventAt = decision.activityAt;
      const appliedStatus = decision.status;
      const nextStatus = appliedStatus ?? existing.status;
      const assigneeKnown = decision.assignee;
      const nextAssigneeId = assigneeKnown
        ? (n.assigneeId ?? null)
        : existing.assigneeId;
      const nextAssigneeType = assigneeKnown
        ? (n.assigneeType ?? null)
        : existing.assigneeType;
      await db.conversation.update({
        where: { id: existing.id },
        data: {
          ...(decision.unversioned && n.contactInboxId != null
            ? { contactInboxId: n.contactInboxId }
            : {}),
          ...(decision.unversioned && inboxRowId != null
            ? { inboxId: inboxRowId }
            : {}),
          ...(decision.unversioned && contactId != null ? { contactId } : {}),
          ...(appliedStatus != null ? { status: appliedStatus } : {}),
          // NOTE: The same question the stale branch asked, and the same answer: see
          // `dropsResolutionOrigin` above.
          ...(dropsResolutionOrigin
            ? { resolvedBy: null, resolvedByAt: null }
            : {}),
          ...(assigneeKnown
            ? {
                assigneeId: n.assigneeId ?? null,
                assigneeType: n.assigneeType ?? null,
                assigneeName: n.assigneeName ?? null,
              }
            : {}),
          lastEventAt: effectiveLastEventAt,
          ...(decision.statusAt != null
            ? { chatwootStatusAt: decision.statusAt }
            : {}),
          ...(decision.assigneeAt != null
            ? { chatwootAssigneeAt: decision.assigneeAt }
            : {}),
          ...(inboundAt != null ? { lastInboundAt: inboundAt } : {}),
          // NOTE: The bags are ASSIGNED (the payload always ships the whole jsonb), but only when the
          // event carried one: a payload without them must not wipe the stored snapshot.
          ...(decision.unversioned && n.customAttributes
            ? { customAttributes: n.customAttributes as Prisma.InputJsonValue }
            : {}),
          ...(decision.unversioned && n.kanbanAttributes
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
      // NOTE: Handoff = the assignee transitions to a human (User). Detect the bot→human edge:
      // prior assignee type was not User and the new one is User. A snapshot older than the state
      // we hold never fires it — its assignee was not applied above. (An undefined trio — degraded
      // payload — never equals "User" either, so it can neither fire nor mask the edge.)
      if (
        assigneeKnown &&
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
        // NOTE: The status as persisted BEFORE this update — the real transition source value.
        prevStatus: existing.status,
        applied: true,
        status: nextStatus,
        // NOTE: EFFECTIVE values (what is stored after this update), not the payload's silence.
        assigneeId: nextAssigneeId,
        assigneeType: nextAssigneeType,
        lastEventAt: effectiveLastEventAt,
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
