import type { MessageContent } from "@langchain/core/messages";
import { contentToText } from "./message-text";

// What a model turn may hand to a person, and what counts as the model choosing to say nothing.
//
// The rule exists because the proactive path ASKS for a token. A follow-up that decides not to
// write is told to answer with EXACTLY `[[SKIP]]`, because "reply with an empty message" produces
// narrated emptiness instead ("(empty — nothing to do yet)"), and that narration is non-empty text
// that would be posted. So the token is the follow-up's vocabulary, and every surface that turns a
// model message into something a person reads has to speak it.
//
// It lives in its own module, and not next to the follow-up that invented it, because the path that
// LEAKED it is the reactive one (issue #454): the memory thread is keyed per contact-inbox, so
// every silent follow-up leaves an assistant turn whose whole content is the token, and a later
// ordinary turn for the same contact can reproduce it. Delivered verbatim on an email inbox, that
// is a real email to whoever wrote in.
const SENTINEL = "[[SKIP]]";

export const FOLLOWUP_SKIP_SENTINEL = SENTINEL;

// The tool that REPLACED the token as the follow-up's way of saying nothing.
export const SKIP_REPLY_TOOL = "skip_reply";

// The tool's OWN acknowledgement, exported so its writer and its reader share one literal rather
// than two copies that drift. `skipReplyRan` is the reader; `skipReplyTool` (tools/native.ts) is the
// writer, and `tests/graph/silence.test.ts` calls the real tool to prove the two still agree.
export const SKIP_REPLY_ACK = "Acknowledged: not replying this turn";

export interface CustomerFacingReply {
  // The model said nothing this turn. Callers post no text; what else the turn produced (a queued
  // image, a deferred resolve, a handoff line) is a separate question and still applies.
  silent: boolean;
  // The text to show or deliver, sentinel-free. Empty exactly when `silent` — the two are derived
  // from one strip rather than decided separately, which is what makes `[[SKIP]][[SKIP]]` behave
  // like `[[SKIP]]` instead of falling between the two answers.
  text: string;
  // The delivered text still CARRIES the token, because editing it out would be the data loss the
  // repo's standing rule prohibits. Nothing is mutated and nothing is suppressed; the caller says so
  // out loud instead, which is what keeps this from being a silent cosmetic leak.
  carriesToken: boolean;
  // Silence caused by the TOKEN rather than by the model writing nothing. Only the caller knows
  // whether that deserves a line: on the proactive path staying silent is the expected outcome, and
  // on the reactive one a customer is waiting, so silence with no trace reads to the operator like
  // the agent ignoring them.
  bySentinel: boolean;
}

// THE REACTIVE RULE, and the narrower of the two on purpose. Nothing in an ordinary turn's prompt
// asks the model for emptiness, so the token is the only string here that means silence — and the
// cost of guessing wrong points the other way from the proactive path: a customer is waiting, and
// swallowing a real answer is its own defect. A reply that REDUCES to the token is silence; a reply
// that merely carries it keeps its text and loses the token.
export function customerFacingReply(raw: string): CustomerFacingReply {
  const trimmed = raw.trim();
  const carriesToken = trimmed.includes(SENTINEL);
  // "Reduces ENTIRELY to the marker" is the whole test, and it is deliberately not a strip of the
  // token wherever it appears. `docs/graph.md` rejects that shape — the citation-marker precedent —
  // because editing a real answer to remove a substring trades a rare cosmetic leak for silent data
  // loss, and the cause fix (the directive asks for a TOOL now) means the only replies that can
  // still carry this token come from transcripts written before it. Wrapping quotes and repetition
  // are tolerated because both are the same reply wearing a hat.
  const bare = trimmed
    .split(SENTINEL)
    .join("")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  const silent = carriesToken ? bare.length === 0 : trimmed.length === 0;
  return {
    silent,
    // Unchanged when it is not silence. The token riding along is a cosmetic leak the caller REPORTS
    // (see `carriesToken`) rather than one this edits away.
    text: silent ? "" : trimmed,
    bySentinel: silent && trimmed.length > 0,
    carriesToken: !silent && carriesToken,
  };
}

// True when the model declined to FOLLOW UP: empty, the skip sentinel (tolerating wrapping quotes),
// a bare "SKIP", or a parenthetical-only "narrated emptiness". The last two are heuristics about
// prose, and they belong to this path alone: they answer a prompt that asked for nothing, and they
// would misread an ordinary reply that happens to be short ("(nada consta)", "(sem juros)") as a
// decision to stay quiet.
export function isNudgeSilent(reply: string): boolean {
  const trimmed = reply.trim();
  if (!trimmed) return true;
  const stripped = trimmed.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (stripped === SENTINEL) return true;
  if (stripped.toUpperCase() === "SKIP") return true;
  // A reply that is ONLY a parenthetical starting with empty/nothing/none (pt-BR + EN) → silence.
  if (/^\((?:empty|vazi|nothing|none|nada|sem|n\/a)[^)]*\)$/i.test(stripped)) {
    return true;
  }
  return false;
}

// THE PROACTIVE RULE: the strip above, plus the narrated-emptiness family, because here the prompt
// DID ask the model to produce nothing and models answer that in prose.
export function proactiveReply(raw: string): CustomerFacingReply {
  if (isNudgeSilent(raw)) {
    // `bySentinel` stays honest: a narrated "(vazio)" is silence, but it is not the token.
    return {
      silent: true,
      text: "",
      bySentinel: raw
        .trim()
        .replace(/^["'`]+|["'`]+$/g, "")
        .includes(SENTINEL),
      carriesToken: false,
    };
  }
  // A real follow-up still loses a stray token, and that asymmetry with the reactive rule is
  // deliberate rather than an oversight. This is the path that ASKED for the token until this
  // change, so a stray occurrence here is an artifact of our own instruction; on the reactive side
  // it can only have come from a transcript, where editing a customer's answer is the data loss
  // `docs/graph.md` prohibits. The behaviour predates this PR and its test is older still — reversing
  // it would be a second change, on a path this issue is not about.
  const drafted = customerFacingReply(raw);
  return {
    ...drafted,
    text: drafted.text.split(SENTINEL).join("").trim(),
    carriesToken: false,
  };
}

// What deciding the channel needs to read. Only the tool SOURCES: whether each one yields a tool is
// `buildToolset`'s answer, and `followupSilenceChannel` asks it directly of the assembled list.
export interface FollowupSilenceConfig {
  nativeToolsAllow?: string[];
  toolPreconditions?: Record<string, unknown>;
  httpToolDefs?: unknown[];
  mcpSelections?: unknown[];
  integrationSelections?: unknown[];
  documentSelections?: unknown[];
  ragConfig?: { knowledgeBaseIds?: unknown[] };
}

// Whether ANY source would put a tool in this turn's toolset, native or not. A CONFIGURED source is
// the question, not an assembled one: this runs before `buildToolset` and its answer decides whether
// the tool is granted at all. The two can differ in one direction only — a source configured that
// yields nothing (an MCP server that is down) — and `followupSilenceChannel` catches that afterwards
// by reading the toolset that actually got built, which is why the grant may be generous here.
function configuresAnyTool(cfg: FollowupSilenceConfig): boolean {
  return (
    (cfg.httpToolDefs?.length ?? 0) > 0 ||
    (cfg.mcpSelections?.length ?? 0) > 0 ||
    (cfg.integrationSelections?.length ?? 0) > 0 ||
    (cfg.documentSelections?.length ?? 0) > 0 ||
    (cfg.ragConfig?.knowledgeBaseIds?.length ?? 0) > 0
  );
}

// The follow-up's silence CHANNEL, as one rule rather than one copy per caller.
//
// The directive (`renderNudge`) asks the model to call `skip_reply`, and `skip_reply` is an
// operator-revocable native tool — so a path that renders the directive without binding the tool
// asks for something that is not there, and a follow-up with nothing to say has to say something.
// That is the leak by another road, which is why this is not left to each call site: there are two
// renderers of that directive (production and the playground simulation), and round 3 of review
// found the second one because round 2 changed the protocol in only the first.
export function withFollowupSilenceChannel<T extends FollowupSilenceConfig>(
  cfg: T,
): T {
  let out = cfg;
  // AN AGENT WITH NO TOOLS AT ALL IS LEFT ALONE, and that is not an oversight. A toolset that is
  // empty is how a tool-less deployment is configured — a plain chat model, or an
  // `openai-compatible` endpoint that answers 400 to any function schema. Forcing one tool back in
  // would make every follow-up call `bindTools` and fail at the provider, trading a token that leaks
  // for a follow-up that never runs. Those agents keep the sentinel as their silence channel;
  // `renderNudge` asks for whichever one they have.
  //
  // EMPTY MEANS EVERY SOURCE, not `nativeToolsAllow` alone, and round 10 of review is why: revoking
  // the natives disables exactly the natives, while HTTP, MCP, toolpack, document and RAG tools are
  // assembled independently (`buildToolset`). An agent with an HTTP tool and no natives already
  // binds a schema on every reactive turn, so the provider argument above does not apply to it — and
  // keying on the native list alone left that agent on the sentinel, persisting `[[SKIP]]` in the
  // shared thread: the exact source this PR exists to remove, kept alive for a whole class of agent.
  if (out.nativeToolsAllow?.length === 0 && !configuresAnyTool(out)) return out;
  // GRANTED. undefined ⇒ every native tool is allowed, so there is nothing to widen.
  if (out.nativeToolsAllow && !out.nativeToolsAllow.includes(SKIP_REPLY_TOOL)) {
    out = {
      ...out,
      nativeToolsAllow: [...out.nativeToolsAllow, SKIP_REPLY_TOOL],
    };
  }
  // ...AND UNGUARDED, which granting alone does not buy. Preconditions are keyed by tool name, are
  // fail-closed, and wrap the tool at the merge point — so an operator condition on `skip_reply`
  // refuses the call the directive now depends on, and the model answers with text instead. It bites
  // hardest in the playground, which has no conversation attributes for a condition to be met by.
  if (out.toolPreconditions && SKIP_REPLY_TOOL in out.toolPreconditions) {
    const { [SKIP_REPLY_TOOL]: _dropped, ...rest } = out.toolPreconditions;
    out = { ...out, toolPreconditions: rest };
  }
  return out;
}

// Whether the tool bound under the silence name is OUR no-op one. `dropDuplicateToolNames` puts
// native tools first, so a native grant WINS the name — which is exactly when the name may be read
// as "this call did nothing". With natives revoked, a custom HTTP tool can hold that name and really
// call something (`toolDefinitionCreateSchema` reserves none), so nothing is inert.
export function inertToolsFor(cfg: {
  nativeToolsAllow?: string[];
}): ReadonlySet<string> {
  const bound =
    cfg.nativeToolsAllow === undefined ||
    cfg.nativeToolsAllow.includes(SKIP_REPLY_TOOL);
  return bound ? new Set([SKIP_REPLY_TOOL]) : new Set<string>();
}

// WHICH CHANNEL THE DIRECTIVE MAY ASK FOR, answered by the toolset that was actually BUILT rather
// than by the config that asked for it. `renderNudge` takes this and nothing else.
//
// Two conditions, and each covers what the other cannot:
//   - the native one is what got BOUND (`inertToolsFor`): with natives revoked, a custom HTTP tool
//     may legitimately carry this name and really call something, and asking the model to call it
//     to stay quiet would fire a side effect on every silent follow-up;
//   - and it is really THERE: a grant is not an assembled tool. `withFollowupSilenceChannel` grants
//     generously — it cannot know that the MCP server behind the only other source is down — so a
//     turn can be granted `skip_reply` and still reach the model with no tool bound at all.
//
// Reading the assembled list is also what makes a third renderer impossible to get wrong: the
// answer comes from the turn's own toolset, not from a condition each call site restates. Round 3
// found the playground because round 2 changed the protocol in only one of two copies of it.
export function followupSilenceChannel(
  cfg: { nativeToolsAllow?: string[] },
  tools: readonly { name: string }[],
): "tool" | "sentinel" {
  return inertToolsFor(cfg).has(SKIP_REPLY_TOOL) &&
    tools.some((t) => t.name === SKIP_REPLY_TOOL)
    ? "tool"
    : "sentinel";
}

// Whether this tool result is OUR no-op tool reporting that it ran — the model's decision to say
// nothing, as opposed to anything else that can arrive under the same name.
//
// A NAME IS NOT AN OUTCOME. An operator may declare a precondition on `skip_reply` like on any other
// native tool (`isGuardableToolName`), and an unmet or unreadable one returns a NORMAL `ToolMessage`
// carrying the same name and a sentence telling the model to carry on — by design, so the turn
// continues. Read by name, that refusal is indistinguishable from silence, and the turn then ends
// with no text at all where the contract says the model must answer: a customer left waiting by the
// rule that was supposed to make the agent more careful.
//
// So the ACK is the identity, and the polarity is deliberate: content this does not recognise is not
// silence, and the caller falls back to making the model finish its turn. An unrecognised result
// costs a wrap-up instruction; an unrecognised refusal costs a customer their answer.
export function skipReplyRan(m: {
  getType: () => string;
  name?: string;
  content: MessageContent;
}): boolean {
  if (m.getType() !== "tool" || m.name !== SKIP_REPLY_TOOL) return false;
  return contentToText(m.content).trimStart().startsWith(SKIP_REPLY_ACK);
}
