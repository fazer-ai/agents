import type { PrismaClient } from "@/../generated/prisma/client";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clearsResolutionOrigin } from "@/modules/conversations/resolution-origin";
import type { LiveConversationState } from "./normalize";

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
}

export interface ReconcileFromLiveParams {
  tenantId: bigint;
  instanceId: bigint;
  // The Chatwoot display id, as used by the mirror's unique key.
  conversationId: number;
  live: LiveConversationState;
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
            status: true,
            assigneeType: true,
            assigneeId: true,
            assigneeName: true,
            lastEventAt: true,
            chatwootStatusAt: true,
            resolvedByAt: true,
            chatwootAssigneeAt: true,
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
        const statusOrdered = orderedBy(current.chatwootStatusAt);
        const assigneeOrdered = orderedBy(current.chatwootAssigneeAt);
        // NOTE: A field the snapshot LOST while a version could rank it — the row holds a strictly
        // newer write, which a caller must not paper over.
        result.outrankedByVersion =
          liveVersion !== null &&
          ((!statusOrdered && current.chatwootStatusAt !== null) ||
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
        const data = {
          ...(statusOrdered && live.status !== current.status
            ? { status: live.status }
            : {}),
          // NOTE: The same rule the webhook mirror applies, from the same function: a live read always
          // speaks about status, and what it is allowed to WRITE is `statusOrdered`.
          ...(clearsResolutionOrigin({
            storedStatus: current.status,
            statedStatus: live.status,
            appliedStatus: statusOrdered ? live.status : null,
            sourceMayStateStatus: true,
            // NOTE: A live snapshot is never a message: it cannot be the customer coming back.
            reopens: false,
            statedVersion: live.updatedAt,
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
          ...(statusOrdered &&
          liveVersion !== null &&
          (current.chatwootStatusAt === null ||
            liveVersion > current.chatwootStatusAt)
            ? { chatwootStatusAt: liveVersion }
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
        result.state = {
          status: statusOrdered ? live.status : current.status,
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
