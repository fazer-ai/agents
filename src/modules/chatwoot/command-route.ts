// Which delivery runs a control command. Chatwoot dispatches an incoming message to the
// conversation's assigned agent bot and to the inbox's (`agent_bot_listener.rb`), so one command
// arrives twice. The inbox's persona runs it: the command is about the agent bound to this inbox.
//
// Both drops fail closed and are different facts. `no_persona`: the inbox's agent has no
// `ChatwootAgentBot` row, cannot speak anywhere (bot-token calls go out empty and get 401), and
// every route drops the command. `other_route`: the persona will run it on its own delivery. The
// reason is returned as data so the reporting line does not re-derive it and disagree.
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
