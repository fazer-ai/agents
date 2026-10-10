// What a reviewer reads beside the preview on a request's page (docs/documents.md, Approval): who
// the customer is, from the contact mirror, and the conversation's last messages, read live from
// Chatwoot. Private notes are left out: the page shows what was said to the customer.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { LoadChatwootClientDeps } from "@/modules/chatwoot/instance";
import { getConversationMessages } from "@/modules/conversations/service";

const RECENT = 10;

export interface ApprovalContextMessage {
  id: number | null;
  content: string | null;
  fromCustomer: boolean;
  senderName: string | null;
  createdAt: number | null;
  // What a message carried besides its text: a voice note or a file with no caption is the customer
  // saying something, so the reviewer sees its kind and the transcription when one exists.
  attachments: { fileType: string | null; transcribedText: string | null }[];
}

export interface ApprovalContextDto {
  conversation: {
    id: string;
    chatwootConversationId: number;
    inboxName: string | null;
  } | null;
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  messages: ApprovalContextMessage[];
  messagesUnavailable: boolean;
}

// Chatwoot pages twenty messages at a time, notes and activity included, so the last ten public ones
// can sit pages back. Older pages are read until ten are found, the history ends, or the page cap is
// reached. Anything that fails, building the client included, leaves the page with the customer and
// without the messages.
const MAX_PAGES = 5;
type ThreadMessage = Awaited<
  ReturnType<typeof getConversationMessages>
>["messages"][number];
async function recentPublicMessages(
  ctx: TenantContext,
  conversationId: bigint,
  deps: LoadChatwootClientDeps,
  base: PrismaClient,
): Promise<{ messages: ThreadMessage[]; messagesUnavailable: boolean }> {
  const isPublic = (m: ThreadMessage) =>
    !m.private && (m.messageType === 0 || m.messageType === 1);
  let found: ThreadMessage[] = [];
  let before: number | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const thread = await getConversationMessages(
        ctx,
        conversationId,
        deps,
        base,
        before,
      );
      if (thread.messagesUnavailable) {
        return { messages: [], messagesUnavailable: true };
      }
      found = [...thread.messages.filter(isPublic), ...found];
      const ids = thread.messages
        .map((m) => m.id)
        .filter((id): id is number => typeof id === "number");
      if (found.length >= RECENT || !thread.hasMoreOlder || ids.length === 0) {
        break;
      }
      before = Math.min(...ids);
    }
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conversationId) },
      "document approval context: Chatwoot messages could not be read",
    );
    return { messages: [], messagesUnavailable: true };
  }
  return { messages: found, messagesUnavailable: false };
}

export async function getApprovalContext(
  ctx: TenantContext,
  requestId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<ApprovalContextDto> {
  const found = await runScopedOn(base, ctx, async (db) => {
    const request = await db.documentApprovalRequest.findUnique({
      where: { id: requestId },
      select: { conversationId: true },
    });
    if (!request) return null;
    if (request.conversationId === null) return { conv: null };
    const conv = await db.conversation.findUnique({
      where: { id: request.conversationId },
      select: {
        id: true,
        chatwootConversationId: true,
        contactId: true,
        inbox: { select: { name: true } },
      },
    });
    if (!conv) return { conv: null };
    const contact =
      conv.contactId === null
        ? null
        : await db.contact.findUnique({
            where: { id: conv.contactId },
            select: { name: true, phone: true, email: true },
          });
    return { conv, contact };
  });
  if (!found) {
    throw new NotFoundError(
      "document approval request not found",
      "errors.documentApprovalNotFound",
    );
  }
  if (!found.conv) {
    return {
      conversation: null,
      contact: null,
      messages: [],
      messagesUnavailable: false,
    };
  }
  const thread = await recentPublicMessages(ctx, found.conv.id, deps, base);
  const messages = thread.messages.slice(-RECENT).map((m) => ({
    id: m.id,
    content: m.content,
    fromCustomer: m.messageType === 0,
    senderName: m.senderName,
    createdAt: m.createdAt,
    attachments: m.attachments.map((a) => ({
      fileType: a.fileType,
      transcribedText: a.transcribedText,
    })),
  }));
  return {
    conversation: {
      id: String(found.conv.id),
      chatwootConversationId: found.conv.chatwootConversationId,
      inboxName: found.conv.inbox?.name ?? null,
    },
    contact: found.contact ?? null,
    messages,
    messagesUnavailable: thread.messagesUnavailable,
  };
}
