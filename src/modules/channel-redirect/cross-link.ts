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

  // The WhatsApp sibling: the same contact's most-recently-active conversation on the entry inbox.
  const sibling =
    p.widgetConv.contactId === null || entryInboxId === null
      ? null
      : await runScopedOn(base, sysCtx(p.tenantId), (db) =>
          db.conversation.findFirst({
            where: {
              contactId: p.widgetConv.contactId,
              chatwootInstanceId: p.instanceId,
              inbox: { chatwootInboxId: entryInboxId },
            },
            select: { chatwootConversationId: true, testActivatedAt: true },
            orderBy: { lastEventAt: "desc" },
          }),
        );

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
