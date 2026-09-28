import type { PrismaClient } from "@/../generated/prisma/client";
import { emitFlowEvent } from "./service";
import type { DeadUnit, FlowLevel } from "./stages";

// The one line a unit of work writes when it reaches a terminal failure: nothing happens
// afterwards, so the state must announce itself on the Logs page and to alert channels, which
// subscribe per stage (hence one stage for every bus). The shared part is the line's shape; each
// bus's own facts go in `detail`. Kinds with their own scheduler dead-letter hook
// (../scheduler/worker.ts) do not come here. Callers pass ids and enums only, never the payload;
// `emitFlowEvent` redacts `detail` regardless.
export function emitDeadLetter(args: {
  tenantId: bigint;
  unit: DeadUnit;
  // Decided per site, never defaulted: `error` for work the system promised to move and lost,
  // `warn` where the operator has their own way back to it. The level is also the blast radius —
  // `AlertChannel.minLevel` defaults to `error` and does not accept `info`, so `warn` reaches only
  // a channel somebody widened on purpose.
  level: FlowLevel;
  error: string;
  // Ids and enums that say WHICH unit died. Never the work's own payload.
  detail: Record<string, unknown>;
  // The conversation thread the unit was working for, when it has one (a follow-up job does): it is
  // what the Logs page filters a conversation by. Absent for units that serve no conversation.
  threadId?: string | null;
  base?: PrismaClient;
}): void {
  emitFlowEvent(
    {
      tenantId: args.tenantId,
      // None of these units is a turn, and none has a conversation to hang off (the two kinds that
      // do have their own hooks). This correlates the one line with itself; `turnId` is still
      // required, because it is what the Logs page groups by.
      turnId: crypto.randomUUID(),
      source: "inbox",
      threadId: args.threadId ?? undefined,
      base: args.base,
    },
    {
      stage: "dead_letter",
      level: args.level,
      status: "error",
      detail: { unit: args.unit, ...args.detail },
      errorMessage: args.error,
    },
  );
}
