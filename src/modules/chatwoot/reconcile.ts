import type { PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clearsResolutionOrigin } from "@/modules/conversations/resolution-origin";
import type { LiveConversationState } from "./normalize";
import { firstOwnershipStamp } from "./state-order";
import { announceStatusChange } from "./status-announce";
import { statusClaimDeferredWins, statusClaimVerdict } from "./status-claim";
import { runResolutionHooks } from "./webhook";

// Applies a live conversation snapshot (REST `GET /conversations/:id`) to the mirror row, under the
// webhook mirror's ordering rule. A GET is the only way to learn the conversation's version
// (`updated_at.to_f`) outside a webhook: the write endpoints never render it. So a caller that acts
// over REST (the proactive nudge's ownership probe, the console's handoff/return/status buttons) reads
// back, or the row keeps a pre-action mark and an in-flight event with the pre-action truth wins.
// The write is conditional three ways: the lastEventAt fence (a webhook committed after the GET is
// newer), per-field ordering against the mark that orders that field, and forward-only marks.
// Nothing is written when nothing differs.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// What the reconcile did. `state` is the row AFTER the call (with `lastEventAt`, since the list sorts
// by it), so an optimistic broadcast announces what is stored, not what the click intended.
// `outrankedByVersion` says why a field did not land: losing to a stored version means something
// strictly newer is in the row and the caller must leave it alone; losing to the coarse activity
// comparison is no evidence, so a caller that just wrote to Chatwoot may still apply its own fields.
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
   * The snapshot's status lost to a local claim rather than to ordering: this side wrote a
   * transition the source has not confirmed. Distinct from `outrankedByVersion` (something newer at
   * the source): a caller that trusts the live read still stands down, because what it lacks is ours.
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
   * The local status claim this caller holds, if any. A claim fences the status against payloads
   * serialized before its write; this read is what earns that write its version, so the owner passes
   * the deadline it wrote and is let through. Null for every other caller is the safe default: a
   * plain live read against a Chatwoot that has not committed someone's toggle would undo the claim.
   */
  ownsStatusClaim?: Date | null;
  /**
   * The read follows an operator's own command (a console write), so what it carries is a DECISION
   * even when it restates the stored state: "Return to AI" on a conversation still `pending` is the
   * operator asking for the agent, and a person's reply serialized before it must not undo that. It
   * stamps the ownership mark (`chatwootOwnershipChangedAt`) at the read's version. Every other read
   * stamps it only when the status or the holder really moved.
   */
  ownershipIsDecision?: boolean;
  base: PrismaClient;
}

interface ResolvedHere {
  inboxId: number | null;
  contactInboxId: number | null;
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
  // What the deferred adjudication has to announce once the transaction it happened in has
  // committed, and null on every other path. See the note where it is filled in.
  let announce: Parameters<typeof broadcastConversationEvent>[1] | null = null;
  // The resolution this call applied, run once the transaction has committed: the webhook for the
  // same transition finds the status already `resolved` and runs nothing.
  let resolved: ResolvedHere | null = null;
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
            // conversation by — needed for the status this write announces below, since the webhook
            // for the same transition will find nothing to announce. The inbox travels with it because
            // subscribers route and filter on it.
            id: true,
            inboxId: true,
            inbox: { select: { chatwootInboxId: true } },
            contactInboxId: true,
            status: true,
            assigneeType: true,
            assigneeId: true,
            assigneeName: true,
            lastEventAt: true,
            chatwootStatusAt: true,
            chatwootOwnershipChangedAt: true,
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
        // A webhook can commit between the caller's GET and this write, making the snapshot the
        // older truth. The conversation's version is exact, used for a field only when both the
        // snapshot and that field's mark carry one; `last_activity_at` is the coarse fallback (1s
        // resolution, unmoved by status or assignee, compared against a `lastEventAt` possibly
        // synthesized from receipt time). Per field, not a veto: letting it reject a versioned write
        // would discard the precise key, and keep discarding it on an inflated `lastEventAt`.
        const activityStale =
          liveAt !== null &&
          current.lastEventAt !== null &&
          sec(current.lastEventAt) > sec(liveAt);
        const orderedBy = (mark: number | null): boolean =>
          liveVersion !== null && mark !== null
            ? liveVersion >= mark
            : !activityStale;
        // A LOCAL CLAIM SOMEBODY ELSE IS HOLDING fences the status here for the same reason it
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
        // The owner's adjudication. This read is the version the source gave our transition. A
        // refusal ahead of it was a write committed after ours (a colleague handing the conversation
        // back mid-toggle), and the only status it can have kept is the one the claim replaced, so
        // that stands; a refusal behind it was a pre-write snapshot and goes. Forward-only against the
        // status mark too: an operator's change applied inside the claim is newer than both.
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
        // A read that did not state the assignee says nothing about it, so the stored holder stands
        // whatever the version: only the fields the read stated are ordered.
        const assigneeStated = live.assigneeStated !== false;
        const assigneeRanked = orderedBy(current.chatwootAssigneeAt);
        const assigneeOrdered = assigneeStated && assigneeRanked;
        // NOTE: a field the snapshot lost while a version could rank it: the row holds a strictly
        // newer write. The version comparison and not `statusOrdered`, so a claim is not reported as
        // one: folded in, the console would return early and its own unversioned fallback (the write
        // that makes the operator's action visible) would never run.
        result.outrankedByVersion =
          liveVersion !== null &&
          ((!statusRanked && current.chatwootStatusAt !== null) ||
            (assigneeStated &&
              !assigneeRanked &&
              current.chatwootAssigneeAt !== null));
        result.applied = statusOrdered && (assigneeOrdered || !assigneeStated);
        // The recency this write leaves in the row, computed once so the caller announces the
        // same value the row holds. It is NOT gated by the ordering marks: those order status and
        // assignee, while activity is monotonic on its own terms.
        const advancesActivity =
          liveAt !== null &&
          (current.lastEventAt === null ||
            sec(liveAt) > sec(current.lastEventAt));
        const nextEventAt = advancesActivity ? liveAt : current.lastEventAt;
        // Only what actually differs. The probe runs on every proactive send, and the
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
        // The assignee this call leaves behind, computed once so the row, the broadcast and the
        // durable event agree. On the deferred path it can differ from the stored trio: the owner's
        // GET may have seen an assignment the refused status event did not carry.
        const nextAssigneeId = assigneeOrdered
          ? live.assigneeId
          : current.assigneeId;
        const nextAssigneeType = assigneeOrdered
          ? live.assigneeType
          : current.assigneeType;
        const nextAssigneeName = assigneeOrdered
          ? live.assigneeName
          : current.assigneeName;
        // The ownership mark, under the same forward-only rule as the field marks: the version at which
        // the status or the holder this read writes actually moved, or at which an operator commanded
        // it (see `ownershipIsDecision`). A restatement leaves it, which is what keeps a person's reply
        // from reading its own echo as a later decision. An operator's command whose read lost the
        // status ordering to a newer restatement still dates the decision at the read's version; a
        // row with no ownership mark falls back to the status mark, already ahead, and is left alone.
        const holderMoved =
          assigneeOrdered &&
          (nextAssigneeType !== current.assigneeType ||
            nextAssigneeId !== current.assigneeId);
        const ownershipMovedAt = Math.max(
          nextStatus !== null &&
            nextStatusAt !== null &&
            (nextStatus !== current.status ||
              params.ownershipIsDecision === true)
            ? nextStatusAt
            : Number.NEGATIVE_INFINITY,
          holderMoved && liveVersion !== null
            ? liveVersion
            : Number.NEGATIVE_INFINITY,
          nextStatus === null &&
            params.ownershipIsDecision === true &&
            liveVersion !== null &&
            current.chatwootOwnershipChangedAt !== null
            ? liveVersion
            : Number.NEGATIVE_INFINITY,
        );
        const ownershipStamp = firstOwnershipStamp(
          {
            ownershipChangedAt: current.chatwootOwnershipChangedAt,
            statusAt: current.chatwootStatusAt,
          },
          Number.isFinite(ownershipMovedAt) ? ownershipMovedAt : null,
        );
        const data = {
          ...(nextStatus !== null && nextStatus !== current.status
            ? { status: nextStatus }
            : {}),
          // NOTE: the claim's bookkeeping, written only by its owner: the version the source gave our
          // transition, and the end of what this call adjudicated. Only this read can produce
          // either. ./status-claim.ts.
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
          (nextAssigneeType !== current.assigneeType ||
            nextAssigneeId !== current.assigneeId ||
            nextAssigneeName !== current.assigneeName)
            ? {
                assigneeType: nextAssigneeType,
                assigneeId: nextAssigneeId,
                assigneeName: nextAssigneeName,
              }
            : {}),
          ...(advancesActivity ? { lastEventAt: nextEventAt } : {}),
          ...(nextStatus !== null &&
          nextStatusAt !== null &&
          (current.chatwootStatusAt === null ||
            nextStatusAt > current.chatwootStatusAt)
            ? { chatwootStatusAt: nextStatusAt }
            : {}),
          ...(ownershipStamp !== null &&
          (current.chatwootOwnershipChangedAt === null ||
            ownershipStamp > current.chatwootOwnershipChangedAt)
            ? { chatwootOwnershipChangedAt: ownershipStamp }
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
        // NOTE: `data.status` is written only when it differs from the stored one, so this is the transition.
        if (data.status === "resolved") {
          resolved = {
            inboxId: current.inbox?.chatwootInboxId ?? null,
            contactInboxId: current.contactInboxId,
          };
        }
        // NOTE: the durable half for EVERY status this call moves, not only the deferred one: the
        // source's own event for the same transition reaches the mirror after this write, finds the
        // status already equal and says nothing. ./status-announce.ts.
        if (nextStatus !== null) {
          await announceStatusChange(db, tenantId, {
            conversationId: current.id,
            inboxId: current.inboxId,
            status: nextStatus,
            previousStatus: current.status,
            assigneeType: nextAssigneeType,
          });
        }
        // NOTE: the realtime half only for the deferred transition, because nothing else will: its
        // webhook was acknowledged with the status refused, and consoles would stay on the claim's
        // `open`. Every other status written here is broadcast by its caller.
        if (
          deferredWins &&
          nextStatus !== null &&
          nextStatus !== current.status
        ) {
          // NOTE: The realtime half waits for this transaction to COMMIT (it is published at the end
          // of this function). Announced from in here, a statement that fails afterwards — or a
          // commit that does — leaves every open console told `pending` while the row rolls back to
          // `open`, which is the ownership gate's own reading and the one thing a console must not
          // disagree with.
          announce = {
            conversationId: String(current.id),
            status: nextStatus,
            assigneeId: nextAssigneeId,
            assigneeType: nextAssigneeType,
            lastEventAt: nextEventAt ? nextEventAt.toISOString() : null,
          };
        }
        result.state = {
          status: nextStatus ?? current.status,
          assigneeId: nextAssigneeId,
          assigneeType: nextAssigneeType,
          assigneeName: nextAssigneeName,
          lastEventAt: nextEventAt,
        };
      },
    ),
  );
  if (announce) broadcastConversationEvent(tenantId, announce);
  // Read through a cast because the assignment happens inside the callback, where the compiler's
  // narrowing of the `null` initializer does not follow it.
  const owed = resolved as ResolvedHere | null;
  if (owed) {
    await runResolutionHooks({
      tenantId,
      instanceId,
      conversationId,
      inboxId: owed.inboxId,
      contactInboxId: owed.contactInboxId,
      base,
    });
  }
  return result;
}
