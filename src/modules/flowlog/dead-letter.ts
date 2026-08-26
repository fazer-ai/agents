import type { PrismaClient } from "@/../generated/prisma/client";
import { emitFlowEvent } from "./service";
import type { DeadUnit, FlowLevel } from "./stages";

// THE ONE LINE A UNIT OF WORK WRITES WHEN NOTHING IS COMING BACK FOR IT (issue #356).
//
// Four buses can reach a terminal failure state, and before this three of them reached it in
// silence. The operator cannot infer any of them: a terminal state is defined by nothing happening
// afterwards, so there is no later symptom to notice and no retry to watch. The state has to
// announce itself where they read, which #274 settled is the `ExecutionLog` row, and for anything
// worth waking someone about, an alert channel — which subscribes to a STAGE, which is why this is
// one stage and not a line per bus.
//
// It is deliberately thin. What each bus knows about its own loss is unlike what the others know,
// so the shared part is exactly the shape of the line (stage, status, where `unit` goes) and the
// per-bus part is the caller's `detail`. Pushing more in here would mean this function taking a
// union of four record types and switching on it, which is the same code with a worse home.
//
// WHAT DOES NOT COME HERE: a kind that registered its own dead-letter hook (../scheduler/worker.ts).
// A richer, conversation-attached line already exists for those, and a generic second one would be
// the same death reported twice in two vocabularies.
//
// The payload never travels. Every caller passes ids and enums; the customer's data is what these
// units CARRY, and a dead-letter line is read by whoever runs the tenant, not by whoever the work
// was about. `emitFlowEvent` redacts and bounds `detail` regardless, as defence in depth.
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
