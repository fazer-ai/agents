import logger from "@/api/lib/logger";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { type HandoffConfig, pinnedHandoffTarget } from "./settings";

export type PinnedAssignment =
  | "agent"
  | "team"
  | "routing"
  | "failed"
  | "withdrawn";

// THE ASSIGNMENT HALF OF A TRANSFER THE RUNTIME MAKES ON ITS OWN, after the status change already
// took the conversation off the bot: the operator's pinned agent or team, else Chatwoot's routing.
// One place, so every hand-over that has no model choosing a target lands where `handoff_to_human`
// would.
// Best-effort and never throws: a failure leaves the conversation open, with a warn line.
export async function assignPinnedTarget(params: {
  client: Pick<ChatwootClient, "assignToAgent" | "assignTeam">;
  conversationId: number;
  instanceId: bigint;
  handoff: HandoffConfig;
  // Asked before the write: a `/reset` or a superseding run must not be followed by a routing write.
  stillWanted?: () => Promise<boolean>;
  logLabel: string;
}): Promise<PinnedAssignment> {
  const { client, conversationId } = params;
  const target = pinnedHandoffTarget(params.handoff, params.instanceId);
  if (!target) return "routing";
  if (params.stillWanted && !(await params.stillWanted())) return "withdrawn";
  try {
    if (target.kind === "agent")
      await client.assignToAgent(conversationId, target.id);
    else await client.assignTeam(conversationId, target.id);
    return target.kind;
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conversationId) },
      `${params.logLabel}: opened, but the pinned target could not be assigned`,
    );
    return "failed";
  }
}
