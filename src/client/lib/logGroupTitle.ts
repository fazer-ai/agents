// WHAT ONE LOGS GROUP CALLS ITSELF, AND WHY THE ANSWER IS NOT ALWAYS "TURN". The page groups rows
// by `turnId`, a CORRELATION id rather than a claim that a turn happened: `route`, `command` and
// `webhook` each synthesize one because they have no turn to belong to. A dead or requeued outbound
// delivery happens on a worker tick long after its event, with no conversation, contact or thread,
// so falling through to the word "Turn" would name a group that can never be one.
export type LogGroupTitle =
  | { kind: "conversation"; conversationId: string }
  | { kind: "thread"; threadId: string }
  | { kind: "stage"; stage: string }
  | { kind: "turn" };

export function logGroupTitle(group: {
  conversationId: string | null;
  threadId: string | null;
  rows: readonly { stage: string }[];
}): LogGroupTitle {
  if (group.conversationId)
    return { kind: "conversation", conversationId: group.conversationId };
  if (group.threadId) return { kind: "thread", threadId: group.threadId };
  // One stage across the whole group: name it by that stage, which is a fact the rows carry rather
  // than an inference about them. This is the branch a `webhook` group takes — its emit gives every
  // line its own `turnId`, so it is always a group of one.
  const first = group.rows[0]?.stage;
  if (first !== undefined && group.rows.every((r) => r.stage === first))
    return { kind: "stage", stage: first };
  // Mixed stages, no conversation and no thread — and "Turn" is honest HERE. The other two stages
  // that hang off no turn cannot reach this branch: `route` and `command` both take a non-null
  // conversation row id (`emitUnroutedMessage`, `emitCommandDropped`), and `webhook` is alone in its
  // group, so what is left is made of turn steps. An empty group takes it too, which no reader can
  // produce (a group exists because a row made it) and which is why this is not an assertion.
  return { kind: "turn" };
}
