import type { PrismaClient } from "@/../generated/prisma/client";
import type { CommandRouteDrop } from "@/modules/chatwoot/command-route";
import type { ControlCommand } from "@/modules/chatwoot/normalize";
import { emitFlowEvent } from "./service";

// A control command (`/teste`, `/reset`) the delivery did not run. Past the gates it reads as a
// plain message, so without this line the conversation looks like a quiet agent. The reasons:
//   inactive     the resolved agent is not in `test` mode (`mode` says which; `unresolved`: none)
//   other_route  it came on another persona's route; the inbox's own persona runs it
//   no_persona   the inbox's agent has no Chatwoot identity, so every route fails closed
// `info`, except `no_persona` at `warn`: level is what alert channels filter on, and that one is a
// misconfiguration that eats every command until the binding is repaired.
export type CommandDrop =
  | { reason: "inactive"; mode: string }
  | CommandRouteDrop;

export function emitCommandDropped(args: {
  tenantId: bigint;
  // The mirrored conversation row, so the line hangs off the conversation the command was typed in.
  conversationRowId: bigint;
  // Null exactly when no agent resolved — the row then names the inbox instead, the same way the
  // unrouted line does.
  agentId: bigint | null;
  inboxRowId: bigint | null;
  command: ControlCommand;
  // The bot whose webhook route this delivery arrived on, null when unattributed.
  routeBot: number | null;
  drop: CommandDrop;
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
      stage: "command",
      level: args.drop.reason === "no_persona" ? "warn" : "info",
      status: "skipped",
      detail: {
        command: args.command,
        ...args.drop,
        ...(args.routeBot !== null ? { routeBot: args.routeBot } : {}),
      },
    },
  );
}
