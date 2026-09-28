import type { BaseMessage } from "@langchain/core/messages";
import {
  endedInHumanAttendance,
  isHumanAgentTurn,
  isHumanHandback,
} from "./markers";
import { chosenSilence, skipReplyRan } from "./silence";
import {
  HANDOFF_DONE_PREFIX,
  HANDOFF_TOOL_NAME,
  OPEN_CASE_HANDED_MARK,
  OPEN_CASE_TOOL_NAME,
} from "./tools/catalog";

// Whether this turn owes the thread a hand-back note. The thread records the START of a human stretch
// (the `handoff_to_human` call, the person's messages) and its END not at all, so an instruction like
// "após transferir, não responda mais" keeps applying after the bot got the conversation back. Derived
// from the thread, not from a takeover column: a column is a copy every writer must stamp correctly,
// and the thread holds the same evidence the model reads. Read backwards to the first thing that
// decides, so it is idempotent: a note after the last evidence means it was announced. Evidence is
// what would keep a model quiet: a handoff that SUCCEEDED (read off its result, since the call is
// checkpointed even when refused), or a message a person sent while the bot was silent.
export function owesHandbackNote(messages: BaseMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined) continue;
    if (isHumanHandback(m)) return false;
    if (isHumanAgentTurn(m)) return true;
    if (handoffSucceeded(m)) return true;
    if (openCaseHandedOver(m)) return true;
    if (skipHandedOver(m)) return true;
    // NOTE: the compacted form of the same evidence: summarizing an attendance takes its handoff with
    // it, so the head replacing it is stamped (./markers.ts; metadata, since the summary text is
    // model-written). Reached LAST by construction: the head sits at the front of the channel.
    if (endedInHumanAttendance(m)) return true;
  }
  return false;
}

// A silence that handed the conversation to a person: `skip_reply` with `not_for_us` or
// `needs_human`, read off the tool's MARK, never its name. It counts because the tool's description
// tells the model those reasons hand the conversation to the team, so the model believes a person
// owns it whether or not the status change landed; when it did not, the note saying so is also true.
function skipHandedOver(message: BaseMessage): boolean {
  if (!skipReplyRan(message)) return false;
  const reason = chosenSilence([message])?.reason;
  return reason === "not_for_us" || reason === "needs_human";
}

// `open_case_in_inbox` hands the conversation to people when the case cannot be opened, and the
// model reads its result as a transfer just like `handoff_to_human`'s.
// Same trust in the name, for the same reason: it is a native name, reserved in the assembly.
function openCaseHandedOver(message: BaseMessage): boolean {
  return (
    message.getType() === "tool" &&
    message.name === OPEN_CASE_TOOL_NAME &&
    typeof message.content === "string" &&
    message.content.includes(OPEN_CASE_HANDED_MARK)
  );
}

// The tool's own result: the NAME the tool node stamps, then the prefix both sides import
// (./tools/catalog.ts). The name matters: an HTTP, MCP or toolpack tool whose result opens with that
// sentence would otherwise announce a hand-back nobody took. It is trustworthy because the assembly
// reserves every native name, including ones the allowlist left out (./tools/unique-names.ts), or an
// agent with the transfer tool off would leave the name free for another tool to answer under.
function handoffSucceeded(message: BaseMessage): boolean {
  return (
    message.getType() === "tool" &&
    message.name === HANDOFF_TOOL_NAME &&
    typeof message.content === "string" &&
    message.content.startsWith(HANDOFF_DONE_PREFIX)
  );
}
