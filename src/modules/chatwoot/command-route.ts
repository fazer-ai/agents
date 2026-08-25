// WHICH DELIVERY RUNS A CONTROL COMMAND, WHEN CHATWOOT SENDS THE SAME ONE TWICE.
//
// Chatwoot dispatches an incoming message to the conversation's ASSIGNED agent bot and to the
// inbox's (`agent_bot_listener.rb`), so a command typed once arrives as two deliveries with two
// route ids. The inbox's persona is the one that runs it — the command is about the agent bound to
// THIS inbox: it is that agent's memory being cleared and that agent the conversation goes back to.
//
// It fails CLOSED on an unresolvable identity, on either side, and the two closed answers are NOT
// the same fact. `no_persona` means the inbox's agent has no `ChatwootAgentBot` row, so it cannot
// speak anywhere (every bot-token call goes out with an empty token and comes back 401, issue #79)
// and EVERY route drops the command: nobody runs it, and waiting does not help. `other_route` means
// this delivery is not the one — the inbox's persona has an identity and will run it on its own
// delivery. Measured on the webhook path (issue #317): both were silent, and the process log line
// said "leaving it to the inbox's persona" for both, which is true of one and misleading for the
// other.
// The two answers that DROP the command, carrying what the line reporting them has to name. Returned
// as data rather than re-derived at the report: a boolean here and a second reading there is exactly
// the shape issue #270 was, one fact answered twice by two readings that can disagree.
export type CommandRouteDrop =
  | { reason: "other_route"; personaBot: number }
  | { reason: "no_persona" };

export type CommandRoute = { reason: "ours" } | CommandRouteDrop;

export function commandRoute(
  // The Chatwoot agent-bot id of the persona bound to this conversation's inbox.
  personaBotId: number | null,
  // The bot whose webhook route THIS delivery arrived on. Null = unattributed, which is not
  // evidence that this is the right one.
  deliveryBotId: number | null,
): CommandRoute {
  if (personaBotId === null) return { reason: "no_persona" };
  if (deliveryBotId === null || deliveryBotId !== personaBotId)
    return { reason: "other_route", personaBot: personaBotId };
  return { reason: "ours" };
}
