import type { PrismaClient } from "@/../generated/prisma/client";
import { emitFlowEvent } from "./service";

// A CUSTOMER MESSAGE WITH NOBODY TO ANSWER IT, AND THE ONE LINE THAT SAYS SO.
//
// The mirror creates an `Inbox` row for any inbox that sends us traffic (`upsertInbox`, deliberately:
// mirroring has to work before an operator binds anything), so an inbox nobody has bound is a real
// row that consumes deliveries and answers nothing. Two exits reach that state on inbound traffic
// and both were silent to the console: the webhook's direct turn returns `no-agent`, and the debounce
// flush bails below its gate. The conversation shows the customer waiting and the Logs page shows
// nothing, which is indistinguishable from an agent that is merely quiet (issue #318).
//
// This is what both exits write, so the page an operator opens to ask "why did nothing happen" can
// answer — the same move issue #271 made for the ownership gate, whose line is emitted from three
// gates through one shared reading for exactly this reason.
//
// `warn`, not `info`: a takeover is the product working and this is a misconfiguration the operator
// has to repair, and it is the one they are most likely to hit right after connecting a channel in
// Chatwoot. It reaches an alert channel set to `warn` for the same reason, coalesced per window by
// the alert worker rather than one alert per message.
//
// `agentId` is null BY CONSTRUCTION here — there is no agent, that is the whole fact — so this row
// does not appear in the Logs page's per-agent filter. `inboxId` is what identifies it instead, and
// naming the inbox is what makes the row a repair rather than a complaint.
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
