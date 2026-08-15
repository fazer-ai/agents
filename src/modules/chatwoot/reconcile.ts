import type { PrismaClient } from "@/../generated/prisma/client";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
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
): Promise<void> {
  const { tenantId, instanceId, conversationId, live, base } = params;
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
            chatwootAssigneeAt: true,
          },
        });
        if (!current) return;
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
        // NOTE: Only what actually differs. The probe runs on every proactive send, and the
        // common outcome is "nothing changed" — writing the same values back would be two
        // updates per follow-up and would advance the row's `updatedAt` for nothing.
        const data = {
          ...(statusOrdered && live.status !== current.status
            ? { status: live.status }
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
          ...(liveAt !== null &&
          (current.lastEventAt === null ||
            sec(liveAt) > sec(current.lastEventAt))
            ? { lastEventAt: liveAt }
            : {}),
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
      },
    ),
  );
}
