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
        if (
          liveAt !== null &&
          current.lastEventAt !== null &&
          sec(current.lastEventAt) > sec(liveAt)
        ) {
          return;
        }
        // NOTE: The same rule the mirror applies, because this is the same kind of payload:
        // a field is written when the version carrying it is at least as new as the mark that
        // orders that field, and the mark moves with it. Writing state without checking would
        // leave fields from the GET under marks from a webhook that landed after it — a stale
        // assignment surviving a live unassignment, with the equal-version rule then keeping
        // the redelivery from clearing it. The REST show renders the same `updated_at.to_f`
        // the webhook does. With no version at all (older Chatwoot) the last_activity_at guard
        // above is all there is, and the write stays unconditional, as it was.
        const liveVersion = live.updatedAt;
        const statusOrdered =
          liveVersion === null ||
          current.chatwootStatusAt === null ||
          liveVersion >= current.chatwootStatusAt;
        const assigneeOrdered =
          liveVersion === null ||
          current.chatwootAssigneeAt === null ||
          liveVersion >= current.chatwootAssigneeAt;
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
