import type { PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clearsResolutionOrigin } from "@/modules/conversations/resolution-origin";
import { emitOutbound } from "@/modules/webhooks/outbound/service";
import type { LiveConversationState } from "./normalize";
import { statusClaimDeferredWins, statusClaimVerdict } from "./status-claim";

// Applies a LIVE conversation snapshot (a REST `GET /conversations/:id`) to the mirror row, under the
// same ordering rule the webhook mirror uses.
//
// Two callers, one reason. A GET is the only way to learn the conversation's own version
// (`updated_at.to_f`) outside a webhook: the write endpoints render an agent or a status blob and
// never that field, while `api/v1/conversations/partials/_conversation.json.jbuilder` renders exactly
// the value the webhook carries. So whoever acts on Chatwoot over REST and then writes this row has
// to read the conversation back, or the row keeps a mark describing the state BEFORE the action, and
// an event that was already in flight — carrying a higher version and the pre-action truth — is
// accepted over it.
//
//   * the proactive nudge, which probes live ownership before spending on a model, and
//   * the console's handoff / return / status buttons (issue #77), whose write is otherwise
//     unversioned and can be undone by a conversation event Chatwoot was still retrying.
//
// The write is conditional in three independent ways, which is what keeps this safe to call after
// any REST action: a webhook committed between the GET and here is newer (the lastEventAt fence), a
// field is only written when the version carrying it is at least as new as the mark that orders that
// field, and each mark only ever moves forward. Nothing is written when nothing differs.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// What the reconcile did, for a caller that has to act on it. The nudge only needs the write to have
// happened; the console needs both halves of this:
//
//   * `state` is the row AFTER the call, so an optimistic broadcast announces what is stored rather
//     than what the click intended — the two differ whenever the snapshot lost, or whenever Chatwoot
//     answered with something other than what was asked for. It carries `lastEventAt` for the same
//     reason as the rest: the snapshot can bring a message the mirror had not seen, this call
//     advances the stored recency, and the conversations list SORTS by the value it is handed;
//   * `outrankedByVersion` says WHY a field did not land. Losing to a stored VERSION is evidence that
//     something strictly newer is in the row, and the caller must leave it alone. Losing to the coarse
//     activity comparison is not evidence of anything (see the fence note below), so a caller that
//     just wrote to Chatwoot and knows what it asked for may still apply its own fields.
export interface ReconcileResult {
  state: {
    status: string;
    assigneeId: number | null;
    assigneeType: string | null;
    assigneeName: string | null;
    lastEventAt: Date | null;
  } | null;
  applied: boolean;
  outrankedByVersion: boolean;
  /**
   * The snapshot's status lost to a LOCAL CLAIM rather than to ordering (issue #436): this side has
   * written a transition the source has not confirmed, so a read taken while it is on the wire is
   * about the state we already decided to leave. Distinct from `outrankedByVersion`, which is about
   * something newer at the SOURCE — a caller that trusts the live read on principle still has to
   * stand down for this one, because the thing it does not know about is ours.
   */
  refusedByStatusClaim: boolean;
}

export interface ReconcileFromLiveParams {
  tenantId: bigint;
  instanceId: bigint;
  // The Chatwoot display id, as used by the mirror's unique key.
  conversationId: number;
  live: LiveConversationState;
  /**
   * The local status claim this caller is holding, when it is holding one (issue #436). A claim
   * fences the status against payloads serialized before the write that took it; this read is not
   * one of those — it is what EARNS that write the version it was made without — so its owner passes
   * the deadline it wrote and is let through.
   *
   * Null for every other caller, and that is the safe default rather than a formality: the nudge's
   * probe is a plain live read, and a Chatwoot that has not yet committed somebody else's toggle
   * would answer it with the pre-toggle status and undo the claim through this write.
   */
  ownsStatusClaim?: Date | null;
  base: PrismaClient;
}

export async function reconcileMirrorFromLive(
  params: ReconcileFromLiveParams,
): Promise<ReconcileResult> {
  const { tenantId, instanceId, conversationId, live, base } = params;
  const result: ReconcileResult = {
    state: null,
    applied: false,
    outrankedByVersion: false,
    refusedByStatusClaim: false,
  };
  // NOTE: Serialize with mirrorChatwootEvent: same per-conversation withEntityLock, and a
  // freshness guard — a webhook committed between our GET and this write is NEWER than the
  // probe snapshot, so the reconcile must not restore stale status/assignee over it. The
  // stored monotonic lastEventAt vs the live payload's last_activity_at decides; when the
  // live is fresher it also advances lastEventAt so later frozen retries stay fenced.
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    withEntityLock(
      db,
      `${tenantId}:${instanceId}:${conversationId}`,
      async () => {
        const where = {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conversationId,
          },
        };
        const current = await db.conversation.findUnique({
          where,
          select: {
            // The mirror's own row id, which is what a console and an outbound consumer name this
            // conversation by — needed only on the deferred path below, which is the one write here
            // that no webhook will announce.
            id: true,
            status: true,
            assigneeType: true,
            assigneeId: true,
            assigneeName: true,
            lastEventAt: true,
            chatwootStatusAt: true,
            resolvedByAt: true,
            chatwootAssigneeAt: true,
            statusClaimUntil: true,
            statusClaimFrom: true,
            statusClaimStampedAt: true,
            statusClaimRefusedAt: true,
          },
        });
        if (!current) return;
        // NOTE: The row as it stands BEFORE any write, so a caller still gets an answer on the paths
        // that write nothing (already in agreement, or outranked).
        result.state = {
          status: current.status,
          assigneeId: current.assigneeId,
          assigneeType: current.assigneeType,
          assigneeName: current.assigneeName,
          lastEventAt: current.lastEventAt,
        };
        // Second-granular like the mirror's monotonic guard (last_activity_at is epoch
        // seconds); a strict > on raw ms would false-skip same-second states.
        const sec = (d: Date) => Math.floor(d.getTime() / 1000);
        const liveAt = live.lastActivityAt;
        const liveVersion = live.updatedAt;
        // NOTE: A webhook can commit BETWEEN the caller's GET and this write, which makes the
        // snapshot in hand the older truth even though it was read later. Two keys can order that,
        // and they are not interchangeable:
        //
        //   * the conversation's own version, which is exact and is what the mirror uses — available
        //     for a field only when BOTH the snapshot carries one and the mark that orders that field
        //     already holds one;
        //   * `last_activity_at`, which is all there is otherwise, and is coarse: one-second
        //     resolution, unmoved by a status or assignee change, and compared against a stored
        //     `lastEventAt` that a payload without it may have synthesized from receipt time.
        //
        // So the activity comparison is the FALLBACK, per field, not a veto over the whole snapshot:
        // letting it reject a versioned write would discard the precise key in favour of the coarse
        // one, and on an inflated `lastEventAt` it would keep discarding it (issue #77, round 1).
        const activityStale =
          liveAt !== null &&
          current.lastEventAt !== null &&
          sec(current.lastEventAt) > sec(liveAt);
        const orderedBy = (mark: number | null): boolean =>
          liveVersion !== null && mark !== null
            ? liveVersion >= mark
            : !activityStale;
        // NOTE: A LOCAL CLAIM SOMEBODY ELSE IS HOLDING fences the status here for the same reason it
        // does in the mirror: this snapshot may have been read before that write reached Chatwoot,
        // and it carries no way to tell. Asked of the status the snapshot STATES, so a read that
        // agrees with the claim's new status is not refused by it. ./status-claim.ts.
        const ours =
          params.ownsStatusClaim != null &&
          current.statusClaimUntil != null &&
          params.ownsStatusClaim.getTime() ===
            current.statusClaimUntil.getTime();
        const verdict = ours
          ? "apply"
          : statusClaimVerdict(
              current,
              // NOTE: A live snapshot is never a message, so it can never be the source's own reopen
              // — the same reading `clearsResolutionOrigin` is handed below, for the same reason.
              { status: live.status, reopens: false, version: liveVersion },
              new Date(),
            );
        const claimed = verdict !== "apply";
        result.refusedByStatusClaim = claimed;
        // NOTE: THE OWNER'S ADJUDICATION (issue #436). This read is the version the source gave our
        // own transition, so it is also the answer to everything the claim had to refuse without one.
        // A refusal ahead of it was a write committed AFTER ours — a colleague handing the
        // conversation back while the toggle was on the wire — and the only status a refusal can have
        // kept is the one the claim replaced, so that is the state that stands. Behind it, the
        // refusal was a snapshot frozen before our write and goes.
        //
        // Forward-only against the status mark as well, for the ordinary reason: an operator's own
        // change applied INSIDE the claim is newer than both, and nothing here may walk it back.
        const deferredAt = current.statusClaimRefusedAt;
        const deferredStatus = current.statusClaimFrom;
        const deferredWins =
          ours &&
          deferredStatus !== null &&
          deferredAt !== null &&
          statusClaimDeferredWins(deferredAt, liveVersion) &&
          (current.chatwootStatusAt === null ||
            deferredAt > current.chatwootStatusAt);
        const statusRanked = orderedBy(current.chatwootStatusAt);
        const statusOrdered = !claimed && !deferredWins && statusRanked;
        const assigneeOrdered = orderedBy(current.chatwootAssigneeAt);
        // NOTE: A field the snapshot LOST while a version could rank it — the row holds a strictly
        // newer write, which a caller must not paper over.
        //
        // The VERSION comparison and not `statusOrdered`, so a claim cannot be reported as one. The
        // two answers are read for opposite purposes: this one tells the console its click was
        // beaten by something newer and it must stand down, and a claim is the exact opposite
        // situation — an unconfirmed local write, which a fresh command outranks by being newer than
        // it. Folded in, the console would return early on `outrankedByVersion` and its own
        // unversioned fallback — the write that makes the operator's action visible at all — would
        // never run.
        result.outrankedByVersion =
          liveVersion !== null &&
          ((!statusRanked && current.chatwootStatusAt !== null) ||
            (!assigneeOrdered && current.chatwootAssigneeAt !== null));
        result.applied = statusOrdered && assigneeOrdered;
        // NOTE: The recency this write leaves in the row, computed once so the caller announces the
        // same value the row holds. It is NOT gated by the ordering marks: those order status and
        // assignee, while activity is monotonic on its own terms.
        const advancesActivity =
          liveAt !== null &&
          (current.lastEventAt === null ||
            sec(liveAt) > sec(current.lastEventAt));
        const nextEventAt = advancesActivity ? liveAt : current.lastEventAt;
        // NOTE: Only what actually differs. The probe runs on every proactive send, and the
        // common outcome is "nothing changed" — writing the same values back would be two
        // updates per follow-up and would advance the row's `updatedAt` for nothing.
        // NOTE: What this call writes for the status: the deferred transition when the owner's own
        // read has just placed it ahead of ours, the snapshot's status when it is ordered, nothing
        // otherwise. One value computed once, so the row, the marks, the resolution origin and the
        // answer the caller broadcasts cannot disagree about which of the three it was.
        const nextStatus = deferredWins
          ? deferredStatus
          : statusOrdered
            ? live.status
            : null;
        const nextStatusAt = deferredWins ? deferredAt : liveVersion;
        const data = {
          ...(nextStatus !== null && nextStatus !== current.status
            ? { status: nextStatus }
            : {}),
          // The claim's own bookkeeping, written by its owner and nobody else: the version the source
          // gave our transition, and the end of whatever this call just adjudicated. Both belong to
          // this read — it is the only one that can produce either. ./status-claim.ts.
          ...(ours && liveVersion !== null
            ? { statusClaimStampedAt: liveVersion }
            : {}),
          ...(ours &&
          liveVersion !== null &&
          current.statusClaimRefusedAt !== null
            ? { statusClaimRefusedAt: null }
            : {}),
          // NOTE: A read refused inside somebody else's gap is kept for exactly the reason a webhook
          // is: it is a reading of the source the owner's own GET may be older than, and the owner
          // would otherwise write its stale snapshot over what this one saw. Nothing else redelivers
          // it — the event that would is the one this window exists because it can be lost.
          ...(verdict === "refuse-and-defer" &&
          liveVersion !== null &&
          (current.statusClaimRefusedAt === null ||
            liveVersion > current.statusClaimRefusedAt)
            ? { statusClaimRefusedAt: liveVersion }
            : {}),
          // NOTE: The same rule the webhook mirror applies, from the same function: a live read always
          // speaks about status, and what it is allowed to WRITE is `statusOrdered`.
          ...(clearsResolutionOrigin({
            storedStatus: current.status,
            statedStatus: nextStatus ?? live.status,
            appliedStatus: nextStatus,
            sourceMayStateStatus: true,
            // NOTE: A live snapshot is never a message: it cannot be the customer coming back.
            reopens: false,
            statedVersion: deferredWins ? deferredAt : live.updatedAt,
            stampedAfterVersion: current.resolvedByAt,
          })
            ? { resolvedBy: null, resolvedByAt: null }
            : {}),
          ...(assigneeOrdered &&
          (live.assigneeType !== current.assigneeType ||
            live.assigneeId !== current.assigneeId ||
            live.assigneeName !== current.assigneeName)
            ? {
                assigneeType: live.assigneeType,
                assigneeId: live.assigneeId,
                assigneeName: live.assigneeName,
              }
            : {}),
          ...(advancesActivity ? { lastEventAt: nextEventAt } : {}),
          ...(nextStatus !== null &&
          nextStatusAt !== null &&
          (current.chatwootStatusAt === null ||
            nextStatusAt > current.chatwootStatusAt)
            ? { chatwootStatusAt: nextStatusAt }
            : {}),
          ...(assigneeOrdered &&
          liveVersion !== null &&
          (current.chatwootAssigneeAt === null ||
            liveVersion > current.chatwootAssigneeAt)
            ? { chatwootAssigneeAt: liveVersion }
            : {}),
        };
        if (Object.keys(data).length === 0) return;
        await db.conversation.update({ where, data });
        // NOTE: THE DEFERRED TRANSITION IS ANNOUNCED HERE, because nothing else will. The webhook that
        // carried it was acknowledged with its status refused, so the mirror emitted nothing and the
        // consoles were last told `open` by the claim itself; a status the database alone knows about
        // leaves every open page and every outbound consumer on the wrong state until some later
        // event happens to correct it (issue #468, round 9). Every OTHER write on this path either
        // agrees with what the source already announced or is announced by its own caller.
        if (
          deferredWins &&
          nextStatus !== null &&
          nextStatus !== current.status
        ) {
          broadcastConversationEvent(tenantId, {
            conversationId: String(current.id),
            status: nextStatus,
            assigneeId: current.assigneeId,
            assigneeType: current.assigneeType,
            lastEventAt: nextEventAt ? nextEventAt.toISOString() : null,
          });
          try {
            await emitOutbound(db, tenantId, "conversation.status_changed", {
              conversation_id: String(current.id),
              inbox_id: null,
              status: nextStatus,
              previous_status: current.status,
              assignee_type: current.assigneeType,
            });
          } catch (err) {
            logger.warn(
              "outbound emit failed (event=conversation.status_changed): %s",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
        result.state = {
          status: nextStatus ?? current.status,
          assigneeId: assigneeOrdered ? live.assigneeId : current.assigneeId,
          assigneeType: assigneeOrdered
            ? live.assigneeType
            : current.assigneeType,
          assigneeName: assigneeOrdered
            ? live.assigneeName
            : current.assigneeName,
          lastEventAt: nextEventAt,
        };
      },
    ),
  );
  return result;
}
