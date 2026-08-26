import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadAgentBot, loadChatwootClient } from "@/modules/chatwoot/instance";
import { episodeOriginQuery } from "./episode";
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
    // The episode's stored origin, when the fork wrote one (#222). Null falls back to the old
    // most-recently-active predicate, which is all a pre-#222 episode has — unless the mark below
    // says the fork spoke and the answer was "none", in which case there is no sibling at all.
    redirectOriginDisplayId: number | null;
    chatwootRedirectOriginAt: number | null;
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
// CLAIMED for the episode this call read (even with no sibling / on a note failure) so this never
// re-runs or re-spams; the notes themselves are best-effort, mirroring the webhook's other
// private-note posts.
export async function linkRedirectConversations(
  p: LinkRedirectParams,
): Promise<LinkRedirectResult> {
  const base = p.base ?? basePrisma;
  const now = p.now ?? new Date();
  const entryInboxId = p.cfg.entryInboxId;

  // The WhatsApp entry half of this episode: the stored pairing when there is one, the old
  // most-recently-active predicate when there is not (episodeOriginQuery's header says why).
  const originQuery =
    entryInboxId === null
      ? null
      : episodeOriginQuery({
          tenantId: p.tenantId,
          instanceId: p.instanceId,
          entryInboxId,
          widget: {
            redirectOriginDisplayId: p.widgetConv.redirectOriginDisplayId,
            chatwootRedirectOriginAt: p.widgetConv.chatwootRedirectOriginAt,
            contactId: p.widgetConv.contactId,
          },
        });
  const sibling = originQuery
    ? await runScopedOn(base, sysCtx(p.tenantId), (db) =>
        db.conversation.findFirst({
          where: originQuery.where,
          select: { chatwootConversationId: true, testActivatedAt: true },
          ...(originQuery.orderBy ? { orderBy: originQuery.orderBy } : {}),
        }),
      )
    : null;

  const propagate = shouldPropagateTestMode(
    p.mode,
    sibling?.testActivatedAt ?? null,
    p.widgetConv.testActivatedAt,
  );

  // CLAIM the cross-link for the episode this call read, rather than stamp it. Two conditions, one
  // question — is this still the episode whose sibling I just looked up?
  //
  // `redirectOriginDisplayId` is the half that #222 made askable. The origin above comes from the
  // delivery's own snapshot, and the stamp below lands after two database round trips and a Chatwoot
  // POST; a pairing accepted in that window moves the episode, and stamping anyway spends the NEXT
  // episode's only shot on the previous one's notes — the inbound that belongs to the new origin
  // finds the watermark set and links nothing, ever. Losing the claim is not a failure: it means
  // another episode owns this conversation now, and its own first inbound will link it.
  //
  // `chatwootRedirectOriginAt` is the third, and it applies ONLY where the origin cannot answer,
  // which is when the origin is null. Since the stated clear became an answer of its own,
  // `(origin=null, mark=null)` and `(origin=null, mark=set)` are different states — never told,
  // versus told there is none — and a claim comparing only the origin reads them as one. A call that
  // resolved its sibling through the recency fallback did so on the licence of the first state; a
  // clear landing under it revokes that licence, and the notes would go to a conversation the source
  // just disowned.
  //
  // Its NULLNESS, never its value: the mark is a version and advances on every payload that states
  // the pairing, the same pairing included, so comparing it for equality would read an ordinary
  // webhook as an episode change and spend this inbound's only attempt on nothing.
  //
  // `redirectLinkedAt: null` is the caller's fence, moved into the same statement. It was read a
  // dozen awaits ago, so two inbounds arriving together both passed it and both posted a pair of
  // private notes. Asked here it costs nothing and the one-shot is one for real.
  //
  // The propagation rides along deliberately: a `/teste` copied from a sibling this conversation is
  // no longer paired with would silence the wrong agent on the wrong episode.
  const claimed = await runScopedOn(base, sysCtx(p.tenantId), async (db) => {
    const res = await db.conversation.updateMany({
      where: {
        id: p.widgetConv.id,
        redirectLinkedAt: null,
        redirectOriginDisplayId: p.widgetConv.redirectOriginDisplayId,
        ...(p.widgetConv.redirectOriginDisplayId === null
          ? {
              chatwootRedirectOriginAt:
                p.widgetConv.chatwootRedirectOriginAt === null
                  ? null
                  : { not: null },
            }
          : {}),
      },
      data: {
        redirectLinkedAt: now,
        ...(propagate ? { testActivatedAt: now } : {}),
      },
    });
    return res.count === 1;
  });
  if (!claimed) {
    logger.info(
      "channel-redirect: cross-link stood down — the episode moved while it read (widget conv=%d)",
      p.widgetConv.displayId,
    );
    return { testActivatedAt: p.widgetConv.testActivatedAt };
  }

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
