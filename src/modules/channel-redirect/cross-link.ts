import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadAgentBot, loadChatwootClient } from "@/modules/chatwoot/instance";
import type { ChannelRedirectConfig } from "./service";

// After the WhatsApp→chat redirect merges a lead onto the widget conversation, this links the two
// conversations of that one contact (see service.ts's header for the whole feature). Runs ONCE, on the
// widget conversation's first inbound after the merge (guarded by the redirectLinkedAt watermark):
//   1. Propagate test-mode activation from the WhatsApp sibling — a /teste given on WhatsApp carries
//      over, so the operator does not have to re-activate in the chat (only in test mode).
//   2. Post cross-link private notes on BOTH conversations (operator-only) pointing at each other, so
//      whoever picks up either side sees the continuous history across channels.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Pure: the operator-facing dashboard deep link of a Chatwoot conversation. `displayId` is the
// per-account conversation number (what we mirror as chatwootConversationId).
export function conversationUrl(
  baseUrl: string,
  accountId: number,
  displayId: number,
): string {
  return `${baseUrl.replace(/\/+$/, "")}/app/accounts/${accountId}/conversations/${displayId}`;
}

// Pure: propagate the WhatsApp side's test activation to the widget only in test mode, only when the
// sibling is active and the widget is not already active. Separated so the decision is unit-testable.
export function shouldPropagateTestMode(
  mode: string,
  siblingTestActivatedAt: Date | null,
  widgetTestActivatedAt: Date | null,
): boolean {
  return (
    mode === "test" &&
    siblingTestActivatedAt !== null &&
    widgetTestActivatedAt === null
  );
}

// Pure: the two cross-link note bodies (operator-only). PT-BR, matching the webhook's other system notes.
export function whatsappSideNote(chatUrl: string): string {
  return `➡️ Cliente seguiu para o chat do site. Conversa: ${chatUrl}`;
}
export function chatSideNote(whatsappUrl: string): string {
  return `⬅️ Origem: WhatsApp. Conversa: ${whatsappUrl}`;
}

export interface LinkRedirectParams {
  tenantId: bigint;
  instanceId: bigint;
  agentId: bigint;
  // The bound agent's mode ("test" | "production"); gates the test-mode propagation.
  mode: string;
  cfg: ChannelRedirectConfig;
  widgetConv: {
    id: bigint;
    // chatwootConversationId (= Chatwoot display_id), what the client + the deep link use.
    displayId: number;
    testActivatedAt: Date | null;
    contactId: bigint | null;
  };
  base?: PrismaClient;
  now?: Date;
}

// The widget conversation's resulting testActivatedAt after a (possible) propagation, so the caller can
// refresh its in-memory ctx before the test-mode gate runs this same turn.
export interface LinkRedirectResult {
  testActivatedAt: Date | null;
}

// Link the widget conversation to its WhatsApp sibling exactly once. The redirectLinkedAt watermark is
// set unconditionally (even with no sibling / on a note failure) so this never re-runs or re-spams; the
// notes themselves are best-effort, mirroring the webhook's other private-note posts.
export async function linkRedirectConversations(
  p: LinkRedirectParams,
): Promise<LinkRedirectResult> {
  const base = p.base ?? basePrisma;
  const now = p.now ?? new Date();
  const entryInboxId = p.cfg.entryInboxId;

  // This contact's conversations on the ENTRY inbox, the ones that redirected first. Two rows is all
  // this needs: the first to work with, and a second whose mere existence answers the question below.
  //
  // The predicate is EXISTENCE, not "has redirected", and that is the load-bearing part. Every
  // redirect anchor is resettable by design — this feature's own /reset clears `redirectSentAt` and
  // zeroes `redirectCount` on both sides precisely so the funnel can be tested twice — while the
  // token those anchors described stays live for its full 24h. So a count over the anchors can drop
  // to one while two links are still out there, and it would read as proof. Rows do not move.
  //
  // Ordered with NULLs LAST, against Postgres's default on DESC, so the row that actually carries a
  // redirect is the one at the front rather than one that never carried an event.
  const candidates =
    p.widgetConv.contactId === null || entryInboxId === null
      ? []
      : await runScopedOn(base, sysCtx(p.tenantId), (db) =>
          db.conversation.findMany({
            where: {
              contactId: p.widgetConv.contactId,
              chatwootInstanceId: p.instanceId,
              inbox: { chatwootInboxId: entryInboxId },
            },
            select: {
              chatwootConversationId: true,
              testActivatedAt: true,
              redirectSentAt: true,
            },
            orderBy: { redirectSentAt: { sort: "desc", nulls: "last" } },
            take: 2,
          }),
        );

  // The best guess, and it is only ever used for things a human reads or a test mode toggles: which
  // conversation the cross-link notes point at, and where a /teste carries over from. Null when no
  // conversation on that inbox has redirected — without one there is no episode to pair, to
  // propagate test mode from, or to cross-link a note to.
  const sibling =
    candidates[0]?.redirectSentAt != null ? (candidates[0] ?? null) : null;

  // The episode's IDENTITY, and it is not the same answer as the guess above, because the bar is not
  // the same. This id is permanent and machines act on it destructively: the closing sends to it, and
  // a /reset tombstones its ladder and its appointment reminders. So it is written only where the
  // rows PROVE it, which is a contact with a single conversation on the entry inbox — every token is
  // minted on one of these, so with one of them there is nothing else the chat could have opened
  // from, whatever the anchors say now.
  //
  // Read off the CANDIDATE and not off `sibling`, which would put the anchor back in the middle of
  // the rule it was taken out of: `sibling` requires a `redirectSentAt`, and the case this whole
  // predicate exists for is the one where /reset wiped that anchor while the link it sent stayed
  // live. There the sole conversation still proves the origin and the guess has nothing to show a
  // human, and gating one on the other stored no identity at all — permanently, since
  // `redirectLinkedAt` closes the one-shot on the way out.
  //
  // With two of them the answer is unknowable here, and not merely unknown. A redirect link is a
  // single-use token with a fixed 24h TTL (docs/channel-redirect.md), so more than one can be live at
  // a time and the newest is only the one we happened to mint last. Nothing in this repo can tell
  // them apart: the token is resolved inside Chatwoot and what comes back identifies the CONTACT, not
  // the conversation it was minted from. Guessing wrong is silent and permanent, so an unknown pair
  // stays unknown and the callers act on one conversation alone, which is what they did before this
  // column existed.
  const entryConversationId =
    candidates.length === 1
      ? (candidates[0]?.chatwootConversationId ?? null)
      : null;

  const propagate = shouldPropagateTestMode(
    p.mode,
    sibling?.testActivatedAt ?? null,
    p.widgetConv.testActivatedAt,
  );

  // Watermark the widget conversation (+ propagate) — ALWAYS, so this one-shot never re-runs.
  await runScopedOn(base, sysCtx(p.tenantId), (db) =>
    db.conversation.update({
      where: { id: p.widgetConv.id },
      data: {
        redirectLinkedAt: now,
        // Written HERE because here is the only moment the two sides are known to belong together:
        // this widget chat opened from a link one of those conversations sent, minutes ago.
        // Everything downstream that asks "which entry is this widget's" reads this instead of
        // comparing anchors, because the anchors admit any LATER episode's widget too.
        redirectEntryConversationId: entryConversationId,
        ...(propagate ? { testActivatedAt: now } : {}),
      },
    }),
  );

  // Cross-link private notes (best-effort). Needs the deployment baseUrl + accountId + the bot client.
  if (sibling) {
    try {
      const inst = await runScopedOn(base, sysCtx(p.tenantId), (db) =>
        db.chatwootInstance.findUniqueOrThrow({
          where: { id: p.instanceId },
          select: {
            accountId: true,
            deployment: { select: { baseUrl: true } },
          },
        }),
      );
      const bot = await loadAgentBot(p.tenantId, p.instanceId, p.agentId, base);
      const client = await loadChatwootClient(p.tenantId, p.instanceId, {
        base,
        botToken: bot?.accessToken,
      });
      const chatUrl = conversationUrl(
        inst.deployment.baseUrl,
        inst.accountId,
        p.widgetConv.displayId,
      );
      const waUrl = conversationUrl(
        inst.deployment.baseUrl,
        inst.accountId,
        sibling.chatwootConversationId,
      );
      await client.sendPrivateNote(
        sibling.chatwootConversationId,
        whatsappSideNote(chatUrl),
      );
      await client.sendPrivateNote(p.widgetConv.displayId, chatSideNote(waUrl));
    } catch (err) {
      logger.warn(
        "channel-redirect: cross-link notes failed (widget conv=%s): %s",
        String(p.widgetConv.displayId),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { testActivatedAt: propagate ? now : p.widgetConv.testActivatedAt };
}
