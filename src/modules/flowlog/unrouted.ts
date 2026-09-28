import type { PrismaClient } from "@/../generated/prisma/client";
import { emitFlowEvent } from "./service";

// A customer message with nobody to answer it. The mirror creates an `Inbox` row for any inbox that
// sends traffic (`upsertInbox`), so an unbound inbox consumes deliveries and answers nothing. Both
// exits that reach this state (the webhook's direct turn returning `no-agent`, and the debounce
// flush's gate) write this line. `warn`, because it is a misconfiguration to repair, coalesced per
// window by the alert worker. `agentId` is null by construction, so `inboxId` is what identifies
// the row.
export function emitUnroutedMessage(args: {
  tenantId: bigint;
  // The mirrored conversation row, so the line hangs off the conversation the customer is writing in.
  conversationRowId: bigint;
  // The mirrored inbox row. Null only when the delivery named an inbox we have no row for, which is
  // the same silence with one less thing to name.
  inboxRowId: bigint | null;
  // Chatwoot's own inbox id, which is what the operator sees in Chatwoot's URL and settings.
  chatwootInboxId: number | null;
  // Only the flush has one to give; the webhook reaches this before any thread is built.
  threadId?: string | null;
  base?: PrismaClient;
}): void {
  emitFlowEvent(
    {
      tenantId: args.tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      conversationId: args.conversationRowId,
      agentId: null,
      inboxId: args.inboxRowId,
      threadId: args.threadId ?? null,
      base: args.base,
    },
    {
      stage: "route",
      level: "warn",
      status: "skipped",
      detail: {
        outcome: "no_agent",
        ...(args.chatwootInboxId !== null
          ? { chatwootInboxId: args.chatwootInboxId }
          : {}),
      },
    },
  );
}
