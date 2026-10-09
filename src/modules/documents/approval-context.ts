// What a reviewer reads beside the preview on a request's page (docs/documents.md, Approval): who
// the customer is, from the contact mirror, and the conversation's last messages, read live from
// Chatwoot. Private notes are left out: the page shows what was said to the customer.

import type { PrismaClient } from "@/../generated/prisma/client";
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
  const thread = await getConversationMessages(ctx, found.conv.id, deps, base);
  const messages = thread.messages
    .filter((m) => !m.private && (m.messageType === 0 || m.messageType === 1))
    .slice(-RECENT)
    .map((m) => ({
      id: m.id,
      content: m.content,
      fromCustomer: m.messageType === 0,
      senderName: m.senderName,
      createdAt: m.createdAt,
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
