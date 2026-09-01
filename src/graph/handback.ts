import type { BaseMessage } from "@langchain/core/messages";
import {
  endedInHumanAttendance,
  isHumanAgentTurn,
  isHumanHandback,
} from "./markers";
import { HANDOFF_DONE_PREFIX, HANDOFF_TOOL_NAME } from "./tools/catalog";

// DOES THIS TURN OWE THE THREAD A HAND-BACK NOTE? (issue #457)
//
// The thread records the START of a human stretch twice over and its END not at all: the agent's own
// `handoff_to_human` call stays in the channel, every message the person sent is folded in beside it,
// and the return to the bot leaves no trace. An operator instruction as ordinary as "após transferir,
// não responda mais" therefore keeps applying to a condition that ended — measured live, one model
// went silent and another sent the silence to the customer as text.
//
// DERIVED FROM THE THREAD, and that is the whole design. The first shape of this fix carried a
// `humanTakeoverAt` column stamped by whoever observed a takeover, and two review rounds produced
// nine findings, every one of them the same shape: a writer that observes it and does not stamp (the
// console's own handoff, a disabled agent), a writer that stamps when it should not (a stale event,
// an opt-out), and a consumer racing the state the column is a copy of. That is what a copy of the
// truth costs. The evidence is already in the channel, in order, and it is the SAME evidence the
// model reads — so the question "does the model believe a person is handling this?" is answered from
// what the model is looking at, not from a column that tries to keep up with it.
//
// Read backwards to the first thing that decides, which makes it idempotent with no bookkeeping: a
// note already sitting after the last piece of human-stretch evidence means this was announced, and
// a second stretch after that note is evidence again.
//
// WHAT COUNTS AS EVIDENCE is exactly what would make a model stay quiet:
//   - a handoff that SUCCEEDED, read off the tool's own result rather than off the call. The AI
//     message carrying the call is checkpointed before the tool runs, so it is there just as much
//     when `toggleStatus` throws and when an operator's precondition refuses the call — and both
//     leave the conversation bot-owned, with no human attendance whose end could be announced;
//   - a message a person sent the customer while the bot was silent (marked at ingestion).
// An operator who assigns a conversation in Chatwoot and never writes leaves neither, and leaves the
// model with no reason to think a human is handling it — so there is nothing to announce.
//
// COMPACTION CARRIES IT, rather than erasing it. Summarizing an attendance away takes its handoff
// and its human messages with it, and a conversation RESOLVED while a person still held it is the
// ordinary way that happens — the next turn would find nothing to read and the agent would go quiet
// again. So the head that replaces the stretch is STAMPED with what the stretch ended in
// (./markers.ts), and that stamp is evidence here like the raw form was. It is metadata and not
// prose for the same reason every marker is: the summary text is model-written.
export function owesHandbackNote(messages: BaseMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined) continue;
    if (isHumanHandback(m)) return false;
    if (isHumanAgentTurn(m)) return true;
    if (handoffSucceeded(m)) return true;
    // The compacted form of the same evidence, and it is reached LAST by construction: the head sits
    // at the front of the channel, so anything after it decides first.
    if (endedInHumanAttendance(m)) return true;
  }
  return false;
}

// The tool's own result: the NAME the tool node stamps on it, and then the prefix both sides import
// (./tools/catalog.ts) rather than a sentence spelled twice.
//
// The name is not decoration. Any enabled tool can return any text, and an HTTP, MCP or toolpack
// tool whose result opens with that sentence would otherwise announce a hand-back for a conversation
// nobody ever took. The name is safe to trust for exactly this tool because the assembly makes it
// so: every native name is reserved there, the built ones by order and the ones an agent's allowlist
// left out by an explicit reservation (./tools/unique-names.ts) — without which an agent with the
// transfer tool turned OFF would leave the name free for someone else to answer under.
function handoffSucceeded(message: BaseMessage): boolean {
  return (
    message.getType() === "tool" &&
    message.name === HANDOFF_TOOL_NAME &&
    typeof message.content === "string" &&
    message.content.startsWith(HANDOFF_DONE_PREFIX)
  );
}
