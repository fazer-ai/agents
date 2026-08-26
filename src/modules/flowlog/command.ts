import type { PrismaClient } from "@/../generated/prisma/client";
import type { CommandRouteDrop } from "@/modules/chatwoot/command-route";
import type { ControlCommand } from "@/modules/chatwoot/normalize";
import { emitFlowEvent } from "./service";

// A CONTROL COMMAND THE DELIVERY DID NOT RUN, AND THE ONE LINE THAT SAYS SO.
//
// `/teste` and `/reset` are the operator driving the tooling from inside the conversation. When one
// does not run, the message is simply gone: past the two gates below every later line describes a
// plain message, and the conversation looks exactly like an agent that is merely quiet. #311 gave
// the first gate a process log line, which is not what an operator reads when they are asking why
// nothing happened; #274 settled that the operator-facing signal for a silence is the `ExecutionLog`
// row, because that is what the Logs page shows (issue #317).
//
// The three reasons are the three measured drops, and they are deliberately one vocabulary rather
// than a line per gate — the operator's question is "did my command run?", asked once:
//
//   inactive     the agent this delivery resolved is not in `test` mode, so the command is ordinary
//                customer text by design. `mode` carries which mode said so, and `unresolved` means
//                no inbox on either reading named an agent at all.
//   other_route  the delivery arrived on another persona's route and left the command to the
//                inbox's own persona, which runs it on its own delivery. Correct behaviour.
//   no_persona   the inbox's agent has no Chatwoot identity, so EVERY route fails closed and the
//                command runs nowhere.
//
// `info`, except `no_persona`. Level is what an alert channel filters on, so it is the whole
// difference between a signal and a page every time an operator types `/teste` at a production
// agent: two of these are things the operator can see and fix from the row itself, and the third is
// a misconfiguration that silently eats every command until someone repairs the binding.
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
