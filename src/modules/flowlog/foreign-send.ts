import type { PrismaClient } from "@/../generated/prisma/client";
import { emitFlowEvent } from "./service";

// The operator-facing sentence of a `foreign_send` line. Fixed text: the message itself is never
// copied, since what it said is the customer's conversation and not a diagnosis.
export const FOREIGN_SEND_MESSAGE =
  "A message was posted with this agent's Agent Bot token by something other than the agent, and the agent did not see it. Posting with the agent's token is not supported: move that step into the agent (prompt, set_custom_attribute, tool preconditions).";

export function emitForeignSend(args: {
  tenantId: bigint;
  conversationRowId: bigint | null;
  agentId: bigint;
  inboxRowId: bigint | null;
  messageId: number | null;
  routeBot: number;
  base?: PrismaClient;
}): void {
  emitFlowEvent(
    {
      tenantId: args.tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      conversationId: args.conversationRowId,
      agentId: args.agentId,
      inboxId: args.inboxRowId,
      base: args.base,
    },
    {
      stage: "foreign_send",
      level: "warn",
      status: "skipped",
      errorMessage: FOREIGN_SEND_MESSAGE,
      detail: {
        agent: String(args.agentId),
        routeBot: args.routeBot,
        ...(args.messageId !== null ? { messageId: args.messageId } : {}),
      },
    },
  );
}
