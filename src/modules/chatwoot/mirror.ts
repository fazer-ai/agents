import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { clearsResolutionOrigin } from "@/modules/conversations/resolution-origin";
import { retireJobsByDedupeKeyOn } from "@/modules/scheduler/service";
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
  // The mirrored INBOX row this event belongs to, upserted here on every event. Exposed because a
  // caller that finds no agent has nothing else to name the inbox with — `rt` is null precisely
  // then, which is the state issue #318 is about. Null when the payload named no inbox.
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
    redirectOriginStated: n.redirectOriginDisplayId !== undefined,
    redirectOriginCleared: n.redirectOriginDisplayId === null,
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

  return runScopedOn(base, sysCtx(tenantId), async (db) => {
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
              redirectOriginAt: existing.chatwootRedirectOriginAt,
              // The mark OR a stored origin: a Chatwoot too old to send `updated_at` writes the
              // pairing and stamps nothing, so the mark alone would read those conversations as
              // never having been told, and a clear there would pass as silence.
              redirectOriginKnown:
                existing.chatwootRedirectOriginAt != null ||
                existing.redirectOriginDisplayId != null,
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

      // The pairing is the redirect episode's IDENTITY, so a genuinely different one means this
      // widget conversation is in a NEW episode and the per-episode one-shots belong to the old one.
      // `redirectLinkedAt` gates the cross-link and `redirectClosedAt` is the at-most-once claim for
      // the goodbye: left standing, the second episode gets neither — the cross-link reads a
      // watermark the first episode set, and the closing CAS asks for a null the first episode spent.
      // Both symptoms predate #222 and neither could be fixed before it, because until the fork
      // recorded the pairing nothing on this side could tell one episode from the next.
      //
      // Asked of a PREVIOUSLY STATED origin, not of the stored value, and that is the whole
      // distinction: stored null is both "the fork never spoke about this conversation" (every
      // conversation, before fazer-ai/chatwoot#418 is deployed) and "the fork said there is none".
      // Being told is what separates them, and it leaves two possible traces — the mark, or a stored
      // origin from an instance too old to send a version to stamp one with. Leaning the
      // other way would release the episode of every live conversation on the day the fork ships,
      // re-running each cross-link and posting its private notes a second time; leaning this way
      // leaves exactly the behaviour of today for a pairing we are only now learning.
      const releasesEpisode =
        existing != null &&
        decision.redirectOrigin &&
        (existing.chatwootRedirectOriginAt != null ||
          existing.redirectOriginDisplayId != null) &&
        (n.redirectOriginDisplayId ?? null) !==
          existing.redirectOriginDisplayId;
      // Written with the pairing wherever the pairing is written, the stale branch included: that
      // branch is where the pairing's own conversation_updated ORDINARILY lands, since
      // `last_activity_at` does not move on a column write.
      // The other half of the release, and it has to be ATOMIC with the pairing write, not merely
      // after it. The ladder messages the paired WhatsApp thread and RESOLVES it, and retiring is the
      // one signal that reaches a worker which has already claimed — a cancel touches PENDING rows
      // only.
      //
      // Outside this transaction the ordering goes wrong in a way that has nothing to do with
      // failure: the pairing's `conversation_updated` and the cloned `message_created` that follows
      // it are two deliveries, and processed concurrently the message can arm the NEW episode's
      // ladder between the pairing committing and a retirement running afterwards — which would then
      // mark the new episode's own job DONE, on a dedupe key that carries no generation to tell them
      // apart. Inside, the UPDATE takes the row lock on that key and holds it to commit, so an arm
      // racing it blocks and lands after. Work armed for the next episode survives; work armed for
      // the previous one does not.
      //
      // A SAVEPOINT, because catching the rejection would not contain the failure. A statement that
      // Postgres rejects — a deadlock, a statement timeout — aborts the whole transaction at the
      // server, and every statement after it fails with `current transaction is aborted` no matter
      // what JavaScript did with the error. Without the savepoint this catch reads as a degradation
      // and delivers a rollback of the whole mirror write.
      //
      // And letting it escape is worse still: this path is detached with Chatwoot's 200 already sent,
      // so a rejection leaves the delivery row on PROCESSING with nothing running and that event
      // never comes back — a transient deadlock in the scheduler would drop the pairing permanently.
      //
      // What must NOT survive the rollback is the pairing. The ladder carries no episode of its own,
      // so committing the new pairing over a ladder that could not be retired hands the PREVIOUS
      // episode's schedule to the NEW one: its next stage re-reads the pairing and nudges, then
      // resolves, a conversation that has just started. So the pairing stands still with it, and
      // nothing is lost by that — every later payload for this conversation restates the pairing and
      // the mark it is ordered by has not moved either, so the next delivery applies both together.
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
      const redirectOriginAt = retiredLadder ? decision.redirectOriginAt : null;
      const episodeRelease =
        releasesEpisode && retiredLadder
          ? { redirectLinkedAt: null, redirectClosedAt: null }
          : {};

      if (existing && decision.stale) {
        // NOTE: A stale event says nothing about the conversation's STATE, with three exceptions, all
        // written here because this branch returns before the update.
        //
        // One is a close of ours that this ordering refused. Another is the redirect pairing, which
        // is ordered by a mark of its own and is routinely carried by a payload that is behind on
        // everything else — see the stale branch of `decideConversationWrites`. `decision` decides
        // both; this only spends the UPDATE when there is something to write, since every
        // out-of-order delivery lands here.
        //
        // The third is the SLA pair, for the same reason stated the other way round: the ORDER this
        // event lost is about the conversation's STATE. The SLA pair is not state this side
        // maintains — it is two immutable readings Chatwoot computed from its own messages table —
        // so losing the ordering says nothing about them, and a row that has never seen them yet is
        // exactly the row a late delivery can still teach. Compared rather than written blind so the
        // common stale delivery, which repeats what is stored, adds no UPDATE.
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
            chatwootAssigneeAt: decision.assigneeAt,
            chatwootRedirectOriginAt: decision.redirectOriginAt,
            lastInboundAt: inboundAt,
            // A row created mid-dialogue needs no special case here: what it stores is what
            // Chatwoot measured over the whole conversation, not what we happened to witness.
            ...slaWrites,

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
          ...(decision.assigneeAt != null
            ? { chatwootAssigneeAt: decision.assigneeAt }
            : {}),
          ...(inboundAt != null ? { lastInboundAt: inboundAt } : {}),
          ...slaWrites,
          // NOTE: The bags are ASSIGNED (the payload always ships the whole jsonb), but only when the
          // event carried one: a payload without them must not wipe the stored snapshot.
          ...(decision.unversioned && n.customAttributes
            ? { customAttributes: n.customAttributes as Prisma.InputJsonValue }
            : {}),
          ...(decision.unversioned && n.kanbanAttributes
            ? { kanbanAttributes: n.kanbanAttributes as Prisma.InputJsonValue }
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

  // Keyed by INSTANCE too: a Chatwoot contact id is unique inside one account, and two accounts
  // under the same tenant were collapsing contact 42 into one row.
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
    },
    // Identity is written below, under a compare-and-set. Unconditionally here, a delivery arriving
    // late would restore what a newer one changed or cleared.
    update: {},
    select: { id: true },
  });

  // The upsert runs BEFORE the conversation's stale check (the conversation row needs the contact
  // id), and one contact is shared by all its conversations, so the conversation guard cannot cover
  // it: the watermark has to be per-contact. ONE statement ⇒ the compare-and-set is atomic under
  // concurrent deliveries, and every field is settled inside the same visit to the row.
  //
  // A watermark PER FIELD, not per row. A payload states a SUBSET of the identity, so a row-wide
  // position would be advanced by an event that never spoke about the field it then protects: a
  // name-only event at t3 would reject a phone clear from t2 arriving behind it, and the gate would
  // go on asking about a number the customer no longer has. Absent means "I know nothing about
  // this", and knowing nothing may not move anything, value or position.
  //
  // These are SOURCE positions, never receipt times: stamping an undated payload with our own clock
  // would make it beat every real Chatwoot timestamp and poison the ordering. An undated payload
  // therefore has NO position, and a write with no position is a write decided by arrival order —
  // the one thing this block exists to prevent — so it writes nothing at all. It used to be let
  // through as a "bootstrap" for a row nothing had positioned yet, except that the watermark stayed
  // null afterwards, so the next undated payload bootstrapped it again, and the one after that: two
  // degraded deliveries naming different phones settled it by whoever arrived last. The bootstrap
  // belongs to the `create` above, which runs exactly once per row. Identity only reaches us on
  // conversation and message events, which carry `last_activity_at` (bots never receive
  // `contact_updated`), so this is the degraded path, and the degraded path fails closed: a contact
  // with nothing positioned reads as `no_identity` at the gate.
  //
  // Each field has two ways to be written, and they are the two CASE arms below:
  //
  //   * STRICTLY NEWER than the field's position: the stated value wins and the position moves.
  //   * EQUAL to it: a tie, decided by DISAGREEMENT rather than arrival order. `last_activity_at`
  //     has one-second resolution, so two events inside one second cannot be ordered at all. Two
  //     payloads that AGREE are one event delivered twice and settle nothing new. Two that state
  //     different values are a conflict nothing can break, and there the field is emptied: keeping
  //     either is a coin toss about whose phone number this is, and the gate would carry the winner
  //     to the operator's endpoint as fact. The position does not move — a tie positions nothing.
  //
  // Anything older than the position falls through to ELSE and changes nothing.
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
