import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { ADDITIONAL_CONTACT_FIELDS } from "@/modules/chatwoot/contact-fields";
import { clearsResolutionOrigin } from "@/modules/conversations/resolution-origin";
import { retireJobsByDedupeKeyOn } from "@/modules/scheduler/service";
import { emitOutbound } from "@/modules/webhooks/outbound/service";
import { isNewIncomingMessage } from "./normalize";
import { decideConversationWrites, type StatePayload } from "./state-order";
import { announceStatusChange } from "./status-announce";
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
  // The mirrored inbox row this event belongs to, upserted on every event. A caller that finds no
  // agent (`rt` null) has nothing else to name the inbox with. Null when the payload named no inbox.
  inboxRowId: bigint | null;
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

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
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
  opts: {
    suppressInboundWatermark?: boolean;
    // The dedupe key of the redirect ladder armed for this conversation, when the caller has one.
    // Handed IN rather than derived here: the key belongs to the channel-redirect module and the
    // mirror has no business knowing how it is spelled — what it owns is the instant it is retired at,
    // which has to be the same transaction that moves the pairing. See `releasesEpisode` below.
    redirectLadderDedupeKey?: string;
  } = {},
): Promise<MirrorResult> {
  if (n.conversationId === null) {
    return {
      conversationRowId: null,
      inboxRowId: null,
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
    assigneeId: n.assigneeId ?? null,
    redirectOriginStated: n.redirectOriginDisplayId !== undefined,
    redirectOriginCleared: n.redirectOriginDisplayId === null,
    // The event that exists only for a status transition says so by its name: the fork dispatches it
    // after commit, when the model's own change record is already gone, so it carries no
    // `changed_attributes`. A holder change has no event of its own and says so in that list.
    ownershipChangeStated:
      n.event === "conversation_status_changed" ||
      changedAttributesNameOwnership(n.changedAttributes),
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

  // Chatwoot's first-response SLA, taken from the payload as it stands. Not ordered against what is
  // stored and not guarded by the staleness decision below: both values are computed at the source
  // from the messages table and never revised, so every delivery mentioning a conversation carries
  // the same two readings, and the latest to arrive writes what the first one would have. Absent
  // (`null`) means the payload said nothing — a conversation with no qualifying reply yet, or a
  // message event with no `conversation` — and must never wipe a stored reading.
  const slaWrites: {
    chatwootCreatedAt?: Date;
    chatwootFirstReplyAt?: Date;
  } = {};
  if (n.conversationCreatedAt != null)
    slaWrites.chatwootCreatedAt = n.conversationCreatedAt;
  if (n.firstReplyCreatedAt != null)
    slaWrites.chatwootFirstReplyAt = n.firstReplyCreatedAt;

  // Twice at most. The contact and inbox upserts run before the per-conversation lock, and
  // Prisma's upsert is a select then an insert, so two deliveries of one event (an observer's route
  // and the responder's) can both miss the row and one loses with a unique violation. P2002 aborts
  // the whole tx, so the retry reruns it: the upsert now takes its update path, and the mirror is
  // idempotent. Without it the losing delivery sits PROCESSING until the sweep.
  let attempt = 0;
  const run = (): Promise<MirrorResult> =>
    runScopedOn(base, sysCtx(tenantId), async (db) => {
      const contactId = await upsertContact(
        db,
        tenantId,
        instanceId,
        n,
        newLastEventAt,
      );
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
            chatwootOwnershipChangedAt: true,
            chatwootAssigneeAt: true,
            assigneeId: true,
            assigneeType: true,
            assigneeName: true,
            status: true,
            resolvedBy: true,
            resolvedByAt: true,
            redirectOriginDisplayId: true,
            // Read so the stale branch can tell a reading it already has from one it does not, and
            // skip the UPDATE in the common case rather than rewriting the same two values.
            chatwootCreatedAt: true,
            chatwootFirstReplyAt: true,
            chatwootRedirectOriginAt: true,
            // Read for the stale branch, which advances this watermark only when the payload really is
            // ahead of it. See the write there.
            lastInboundAt: true,
            // NOTE: the local claim, the one ordering input that does not come from the source.
            // See ./status-claim.ts.
            statusClaimUntil: true,
            statusClaimFrom: true,
            statusClaimStampedAt: true,
            statusClaimRefusedAt: true,
          },
        });
        const prevAssigneeId = existing?.assigneeId ?? null;
        const decision = decideConversationWrites(
          statePayload,
          existing
            ? {
                status: existing.status,
                activityAt: existing.lastEventAt,
                statusAt: existing.chatwootStatusAt,
                ownershipChangedAt: existing.chatwootOwnershipChangedAt,
                assigneeAt: existing.chatwootAssigneeAt,
                assigneeType: existing.assigneeType,
                assigneeId: existing.assigneeId,
                redirectOriginAt: existing.chatwootRedirectOriginAt,
                // The mark OR a stored origin: a Chatwoot too old to send `updated_at` writes the
                // pairing and stamps nothing, so the mark alone would read those conversations as
                // never having been told, and a clear there would pass as silence.
                redirectOriginKnown:
                  existing.chatwootRedirectOriginAt != null ||
                  existing.redirectOriginDisplayId != null,
                statusClaimUntil: existing.statusClaimUntil,
                statusClaimFrom: existing.statusClaimFrom,
                statusClaimStampedAt: existing.statusClaimStampedAt,
                statusClaimRefusedAt: existing.statusClaimRefusedAt,
              }
            : null,
          now,
        );
        // Whether this event kills a recorded resolution origin, asked once for both exits
        // below (the stale branch returns before the update), so the rule is not stated twice. Why it
        // takes these three facts and not `decision.stale` is in `clearsResolutionOrigin`.
        const dropsResolutionOrigin =
          existing != null &&
          clearsResolutionOrigin({
            storedStatus: existing.status,
            statedStatus: statePayload.status,
            appliedStatus: decision.status,
            // NOTE: a conversation event speaks about status; a message snapshot embeds one but moves
            // no state. Not `&& version != null`: a versionless conversation event is ordered by
            // `last_activity_at` and may move status, so requiring a version would exempt every
            // Chatwoot older than 4.0.2 from the rule.
            sourceMayStateStatus: statePayload.fromConversationEvent,
            reopens: statePayload.reopensConversation,
            statedVersion: statePayload.version,
            stampedAfterVersion: existing.resolvedByAt,
          });

        // The pairing is the redirect episode's identity, so a different one starts a new episode
        // and the per-episode one-shots (`redirectLinkedAt` for the cross-link, `redirectClosedAt` for
        // the goodbye) belong to the old one. Asked of a previously STATED origin, not the stored
        // value: stored null means both "the fork never spoke" and "the fork said none", and being told
        // (the mark, or a stored origin from an instance too old to stamp one) separates them. Leaning
        // the other way would release every live conversation's episode the day the fork ships,
        // re-running each cross-link and its private notes.
        const releasesEpisode =
          existing != null &&
          decision.redirectOrigin &&
          (existing.chatwootRedirectOriginAt != null ||
            existing.redirectOriginDisplayId != null) &&
          (n.redirectOriginDisplayId ?? null) !==
            existing.redirectOriginDisplayId;
        // Written with the pairing wherever the pairing is written, the stale branch included
        // (a column write does not move `last_activity_at`). Retiring the ladder is atomic with the
        // pairing write, inside a savepoint, and a failed retirement holds the pairing back so the old
        // episode's schedule is never handed to the new one. Why each of those is required:
        // docs/chatwoot.md, "Mirror sync".
        let retiredLadder = true;
        if (releasesEpisode && opts.redirectLadderDedupeKey) {
          await db.$executeRawUnsafe("SAVEPOINT retire_redirect_ladder");
          try {
            await retireJobsByDedupeKeyOn(
              db,
              tenantId,
              "REDIRECT_FOLLOWUP",
              opts.redirectLadderDedupeKey,
              // The episode this write is moving TO. Work already armed for it is the new episode's,
              // and the retirement is only about the one being left behind.
              { originDisplayId: n.redirectOriginDisplayId ?? null },
            );
            await db.$executeRawUnsafe(
              "RELEASE SAVEPOINT retire_redirect_ladder",
            );
          } catch (err) {
            await db.$executeRawUnsafe(
              "ROLLBACK TO SAVEPOINT retire_redirect_ladder",
            );
            retiredLadder = false;
            logger.warn(
              "chatwoot: could not retire the previous redirect episode's ladder, holding the pairing back (conv=%s): %s",
              String(convId),
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        // The pairing moves only with a ladder that stood down. Everything else this event carries is
        // unaffected: the mirror writes each field on its own terms.
        const writesRedirectOrigin = decision.redirectOrigin && retiredLadder;
        const redirectOriginAt = retiredLadder
          ? decision.redirectOriginAt
          : null;
        const episodeRelease =
          releasesEpisode && retiredLadder
            ? { redirectLinkedAt: null, redirectClosedAt: null }
            : {};

        if (existing && decision.stale) {
          // A stale event says nothing about the conversation's state, with three exceptions
          // written here because this branch returns before the update: a close of ours this ordering
          // refused, the redirect pairing (ordered by its own mark, see `decideConversationWrites`),
          // and the SLA pair (two immutable readings Chatwoot computed from its messages table, which
          // a late delivery can still teach). Each is compared first, so the common stale delivery
          // that repeats what is stored adds no UPDATE.
          const staleSla: typeof slaWrites = {};
          if (
            slaWrites.chatwootCreatedAt != null &&
            slaWrites.chatwootCreatedAt.getTime() !==
              existing.chatwootCreatedAt?.getTime()
          )
            staleSla.chatwootCreatedAt = slaWrites.chatwootCreatedAt;
          if (
            slaWrites.chatwootFirstReplyAt != null &&
            slaWrites.chatwootFirstReplyAt.getTime() !==
              existing.chatwootFirstReplyAt?.getTime()
          )
            staleSla.chatwootFirstReplyAt = slaWrites.chatwootFirstReplyAt;
          const staleWrites = {
            ...(dropsResolutionOrigin && existing.resolvedBy != null
              ? { resolvedBy: null, resolvedByAt: null }
              : {}),
            ...(writesRedirectOrigin
              ? { redirectOriginDisplayId: n.redirectOriginDisplayId ?? null }
              : {}),
            ...(redirectOriginAt != null
              ? { chatwootRedirectOriginAt: redirectOriginAt }
              : {}),
            ...episodeRelease,
            ...staleSla,
            ...(decision.ownershipChangedAt != null
              ? { chatwootOwnershipChangedAt: decision.ownershipChangedAt }
              : {}),
            // NOTE: the inbound watermark is monotonic and not decided by this branch's ordering:
            // `lastInboundAt` is the time of a customer message, and a newer one is newer whatever the
            // state did. It anchors the follow-up "new episode" gate and the WhatsApp 24h window, so a
            // recovered body landing here must still advance it. Never backwards. No guard on the
            // payload carrying a timestamp: an undated event never reaches this branch
            // (`decideConversationWrites` has nothing to order it by and applies it), and
            // ./recover-delivery.ts refuses to rebuild an undated body.
            ...(inboundAt != null &&
            (existing.lastInboundAt === null ||
              inboundAt.getTime() > existing.lastInboundAt.getTime())
              ? { lastInboundAt: inboundAt }
              : {}),
          };
          if (Object.keys(staleWrites).length > 0) {
            await db.conversation.update({
              where: { id: existing.id },
              data: staleWrites,
            });
          }
          return {
            conversationRowId: existing.id,
            inboxRowId,
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
              chatwootOwnershipChangedAt: decision.ownershipChangedAt,
              chatwootAssigneeAt: decision.assigneeAt,
              chatwootRedirectOriginAt: decision.redirectOriginAt,
              lastInboundAt: inboundAt,
              // A row created mid-dialogue needs no special case here: what it stores is what
              // Chatwoot measured over the whole conversation, not what we happened to witness.
              ...slaWrites,

              ...(n.customAttributes
                ? {
                    customAttributes:
                      n.customAttributes as Prisma.InputJsonValue,
                  }
                : {}),
              ...(n.kanbanAttributes
                ? {
                    kanbanAttributes:
                      n.kanbanAttributes as Prisma.InputJsonValue,
                  }
                : {}),
              ...(decision.redirectOrigin
                ? { redirectOriginDisplayId: n.redirectOriginDisplayId ?? null }
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
            inboxRowId,
            prevAssigneeId,
            // NOTE: No prior row → no prior status (never a "transition" for a brand-new conversation).
            prevStatus: null,
            applied: true,
            status: createdStatus,
            assigneeId: n.assigneeId ?? null,
            assigneeType: n.assigneeType ?? null,
            lastEventAt: createdLastEventAt,
            // A row born now has no previous episode to release.
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
            ...(decision.ownershipChangedAt != null
              ? { chatwootOwnershipChangedAt: decision.ownershipChangedAt }
              : {}),
            // The claim's own record of what it could not place, which the takeover's reconcile reads
            // back and answers. See `statusClaimRefusedAt` on the decision.
            ...(decision.statusClaimRefusedAt != null
              ? { statusClaimRefusedAt: decision.statusClaimRefusedAt }
              : {}),
            ...(decision.assigneeAt != null
              ? { chatwootAssigneeAt: decision.assigneeAt }
              : {}),
            ...(inboundAt != null ? { lastInboundAt: inboundAt } : {}),
            ...slaWrites,
            // NOTE: The bags are ASSIGNED (the payload always ships the whole jsonb), but only when the
            // event carried one: a payload without them must not wipe the stored snapshot.
            ...(decision.unversioned && n.customAttributes
              ? {
                  customAttributes: n.customAttributes as Prisma.InputJsonValue,
                }
              : {}),
            ...(decision.unversioned && n.kanbanAttributes
              ? {
                  kanbanAttributes: n.kanbanAttributes as Prisma.InputJsonValue,
                }
              : {}),
            // NOTE: Fenced by its OWN version mark, not by the recency the bags use. A widget
            // conversation can be re-entered from a second WhatsApp thread, and every payload carries
            // the pairing as of when it was SERIALIZED — a retried delivery (3 attempts, 3s apart)
            // therefore carries the older answer and would otherwise regress the row. `last_activity_at`
            // cannot separate two re-entries inside one second, and it does not move at all when the
            // fork records the pairing, so ordering this field by recency would both miss the race and
            // discard the conversation_updated that announces the change. The consumer messages AND
            // resolves the conversation this names, so a regression acts on the wrong thread.
            ...(writesRedirectOrigin
              ? { redirectOriginDisplayId: n.redirectOriginDisplayId ?? null }
              : {}),
            ...(redirectOriginAt != null
              ? { chatwootRedirectOriginAt: redirectOriginAt }
              : {}),
            ...episodeRelease,
          },
        });
        const inboxIdStr = inboxRowId != null ? String(inboxRowId) : null;
        if (appliedStatus != null) {
          await announceStatusChange(db, tenantId, {
            conversationId: existing.id,
            inboxId: inboxRowId,
            status: appliedStatus,
            previousStatus: existing.status,
            assigneeType: nextAssigneeType,
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
          inboxRowId,
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
  for (;;) {
    try {
      return await run();
    } catch (err) {
      attempt += 1;
      if (attempt > 1 || !isUniqueViolation(err)) throw err;
      logger.info(
        "chatwoot: the mirror lost a race on a new row (conv=%s); running it again",
        String(convId),
      );
    }
  }
}

async function upsertContact(
  db: ScopedDb,
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  eventAt: Date | null,
): Promise<bigint | null> {
  const c = n.contact;
  if (!c || c.id == null) return null;
  // Every identity field follows one rule, because they feed one decision. ABSENT (`undefined`)
  // keeps what is stored: a degraded payload must not wipe identity. STATED is written exactly as
  // Chatwoot says, cleared included — the gate asks the endpoint about whoever these values name,
  // so a phone kept after it was removed asks about whoever used to have it.
  const nameStated = c.name !== undefined;
  const emailStated = c.email !== undefined;
  const phoneStated = c.phone !== undefined;
  const attrsStated = c.identifier !== undefined;
  const attrs = JSON.stringify(
    c.identifier ? { identifier: c.identifier } : {},
  );
  const additional: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.additionalAttributes ?? {})) {
    if (value) additional[key] = value;
  }

  // Keyed by instance too: a Chatwoot contact id is unique only inside one account, and two
  // accounts under one tenant can share an id.
  const row = await db.contact.upsert({
    where: {
      tenantId_chatwootInstanceId_chatwootContactId: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootContactId: c.id,
      },
    },
    create: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootContactId: c.id,
      name: c.name ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      attributes: (c.identifier
        ? { identifier: c.identifier }
        : {}) as Prisma.InputJsonValue,
      additionalAttributes: additional as Prisma.InputJsonValue,
    },
    // Identity is written below, under a compare-and-set. Unconditionally here, a delivery arriving
    // late would restore what a newer one changed or cleared.
    update: {},
    select: { id: true },
  });

  // NOTE: a per-field compare-and-set watermark, in one statement so it is atomic under concurrent
  // deliveries. Per contact because the upsert runs before the conversation's stale check and one
  // contact is shared by all its conversations; per field because a payload states a subset of the
  // identity, and absent may move nothing. Positions are source times, never receipt times: an
  // undated payload writes nothing and the bootstrap is the `create` above. Strictly newer wins and
  // moves the position; an equal position that disagrees empties the field (a one-second tie nothing
  // can break); older changes nothing. Full reasoning: docs/chatwoot.md, "Mirror sync".
  if (eventAt && (nameStated || emailStated || phoneStated || attrsStated)) {
    await db.$executeRaw`
      UPDATE contacts SET
        name = CASE
          WHEN ${nameStated} AND (name_at IS NULL OR name_at < ${eventAt}) THEN ${c.name ?? null}::text
          WHEN ${nameStated} AND name_at = ${eventAt} AND name IS DISTINCT FROM ${c.name ?? null}::text THEN NULL
          ELSE name END,
        name_at = CASE
          WHEN ${nameStated} AND (name_at IS NULL OR name_at < ${eventAt}) THEN ${eventAt}
          ELSE name_at END,
        email = CASE
          WHEN ${emailStated} AND (email_at IS NULL OR email_at < ${eventAt}) THEN ${c.email ?? null}::text
          WHEN ${emailStated} AND email_at = ${eventAt} AND email IS DISTINCT FROM ${c.email ?? null}::text THEN NULL
          ELSE email END,
        email_at = CASE
          WHEN ${emailStated} AND (email_at IS NULL OR email_at < ${eventAt}) THEN ${eventAt}
          ELSE email_at END,
        phone = CASE
          WHEN ${phoneStated} AND (phone_at IS NULL OR phone_at < ${eventAt}) THEN ${c.phone ?? null}::text
          WHEN ${phoneStated} AND phone_at = ${eventAt} AND phone IS DISTINCT FROM ${c.phone ?? null}::text THEN NULL
          ELSE phone END,
        phone_at = CASE
          WHEN ${phoneStated} AND (phone_at IS NULL OR phone_at < ${eventAt}) THEN ${eventAt}
          ELSE phone_at END,
        attributes = CASE
          WHEN ${attrsStated} AND (attributes_at IS NULL OR attributes_at < ${eventAt}) THEN ${attrs}::jsonb
          WHEN ${attrsStated} AND attributes_at = ${eventAt} AND attributes IS DISTINCT FROM ${attrs}::jsonb THEN '{}'::jsonb
          ELSE attributes END,
        attributes_at = CASE
          WHEN ${attrsStated} AND (attributes_at IS NULL OR attributes_at < ${eventAt}) THEN ${eventAt}
          ELSE attributes_at END
      WHERE id = ${row.id} AND tenant_id = ${tenantId}
    `;
  }

  // NOTE: The additional fields follow the identity rule (absent keeps, strictly newer wins, older
  // changes nothing) under their OWN position, so a city edit never moves the identifier's. On a tie
  // only the keys the two snapshots disagree on are emptied.
  if (eventAt && c.additionalAttributes !== undefined) {
    const bag = JSON.stringify(additional);
    await db.$executeRaw`
      UPDATE contacts SET
        additional_attributes = CASE
          WHEN additional_attributes_at IS NULL OR additional_attributes_at < ${eventAt} THEN ${bag}::jsonb
          WHEN additional_attributes_at = ${eventAt} THEN additional_attributes - ARRAY(
            SELECT k FROM unnest(${ADDITIONAL_CONTACT_FIELDS}::text[]) AS k
            WHERE additional_attributes -> k IS DISTINCT FROM ${bag}::jsonb -> k
          )
          ELSE additional_attributes END,
        additional_attributes_at = CASE
          WHEN additional_attributes_at IS NULL OR additional_attributes_at < ${eventAt} THEN ${eventAt}
          ELSE additional_attributes_at END
      WHERE id = ${row.id} AND tenant_id = ${tenantId}
    `;
  }

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

// The columns whose change moves who holds a conversation in the fork: the status, the human
// assignee, the bot assignee, and the type that says which of the two is meant.
const OWNERSHIP_ATTRIBUTES = [
  "status",
  "assignee_id",
  "assignee_agent_bot_id",
  "ai_assignee_type",
];

// Whether a conversation event's `changed_attributes` names one of them. Chatwoot renders it as a
// list of one-key objects (`[{ status: { previous_value, current_value } }]`); anything else, or its
// absence on a message payload, is no statement.
function changedAttributesNameOwnership(changed: unknown): boolean {
  if (!Array.isArray(changed)) return false;
  return changed.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      OWNERSHIP_ATTRIBUTES.some((key) => Object.hasOwn(entry as object, key)),
  );
}
