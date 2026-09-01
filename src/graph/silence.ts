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
// than two copies that drift. It is what the MODEL reads; it is not what identifies the tool.
export const SKIP_REPLY_ACK = "Acknowledged: not replying this turn";

// WHAT IDENTIFIES THE TOOL, and it is deliberately not text. The ack is published in this repo, and
// with natives revoked an operator may legitimately bind a custom HTTP tool under this name whose
// response body they do not control — a third-party API, or a customer's own words echoed back. A
// body that happens to begin with the ack would then be read as a decision to stay silent, and the
// turn would end without answering: a denial of the customer's reply, reachable by injection.
//
// `additional_kwargs` is out of reach of any response body: only the tool that builds the
// `ToolMessage` can set it, and `skipReplyTool` is the only thing that does (round 24).
export const SKIP_REPLY_MARK = "fazer_skip_reply";

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
  // The model WROTE something, whether or not any of it is deliverable. The distinction the rules
  // above erase on purpose — every kind of silence comes out as `text: ""` — and the one a caller
  // needs to ask "is there anything in the thread that nobody received": a turn that wrote the token,
  // or a narrated "(nada a fazer)", left words behind; one that produced an empty message did not.
  // Kept here rather than re-read from the message, because a second reader of the model's final text
  // is exactly what `tests/graph/silence.test.ts` fences against.
  wroteText: boolean;
}

// THE REACTIVE RULE, and the narrower of the two on purpose. Nothing in an ordinary turn's prompt
// asks the model for emptiness, so the token is the only string here that means silence — and the
// cost of guessing wrong points the other way from the proactive path: a customer is waiting, and
// swallowing a real answer is its own defect. A reply that REDUCES to the token is silence; a reply
// that merely carries it keeps its text and loses the token.
export function customerFacingReply(raw: string): CustomerFacingReply {
  const trimmed = raw.trim();
  const carriesToken = trimmed.includes(SENTINEL);
  const wroteText = trimmed.length > 0;
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
    wroteText,
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
      wroteText: raw.trim().length > 0,
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

// What granting the channel needs to read. Which tools a source actually YIELDS is `buildToolset`'s
// answer and nothing here can anticipate it — `withoutLoneSilenceTool` asks the assembled list
// instead, afterwards.
export interface FollowupSilenceConfig {
  nativeToolsAllow?: string[];
  toolPreconditions?: Record<string, unknown>;
  httpToolDefs?: { name: string }[];
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
  // THE NAME IS NOT TAKEN FROM A TOOL THE OPERATOR ALREADY HAS. `toolDefinitionCreateSchema` reserves
  // no native names, so an agent with natives revoked can legitimately run a custom HTTP tool called
  // `skip_reply` — and `dropDuplicateToolNames` puts natives FIRST, so granting ours would evict
  // theirs from every follow-up turn. A tool the operator built, silently gone, to install a channel
  // they never asked for. Those agents keep the sentinel.
  //
  // ONLY WHEN THEIRS ACTUALLY WINS, which is when the native is not already granted. With the native
  // in the allowlist it wins the name anyway, so returning early there protected nothing and skipped
  // the precondition cleanup below — leaving a fail-closed guard on the very call the directive
  // depends on, which is the leak by the third road all over again (round 15).
  if (
    !inertToolsFor(out).has(SKIP_REPLY_TOOL) &&
    out.httpToolDefs?.some((d) => d.name === SKIP_REPLY_TOOL)
  ) {
    return out;
  }
  // NOTHING ELSE IS ASKED HERE, and round 12 is why. Granting used to be gated on whether any source
  // was CONFIGURED, which is not the same question as whether any tool gets BUILT: an MCP server
  // that is down is configured and yields nothing, and the grant then handed a lone function schema
  // to an endpoint that had been running tool-less on the sentinel — the whole follow-up fails at
  // the provider instead of one token leaking. Only the assembled list can answer that, so it is
  // answered there (`withoutLoneSilenceTool`) and this grants freely.
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
  additional_kwargs?: Record<string, unknown>;
}): boolean {
  if (m.getType() !== "tool" || m.name !== SKIP_REPLY_TOOL) return false;
  return m.additional_kwargs?.[SKIP_REPLY_MARK] === true;
}

// OUR PROTOCOL TOOL IS NEVER THE ONLY TOOL A FOLLOW-UP BINDS, asked of the toolset that was actually
// built. A list holding nothing but `skip_reply` means every other source yielded nothing, so this
// agent is tool-less in practice — and a tool-less deployment is a real configuration (a plain chat
// model, or an `openai-compatible` endpoint that answers 400 to any function schema). Binding one
// no-op tool there trades a token that leaks for a follow-up that never runs, so the tool comes back
// out and `followupSilenceChannel` then answers `sentinel` on its own.
//
// FOLLOW-UP ONLY, and the scope is the point: an operator who granted `skip_reply` and nothing else
// gets exactly that on a REACTIVE turn, which is how their agent answers "ok" and "obrigado" with
// silence. This rule belongs to the path that adds the tool, not to every path that binds one.
//
// AND A NAME IS NOT AN IDENTITY, here as everywhere else in this file. With natives revoked, the
// lone tool under this name is the operator's own HTTP tool — `withFollowupSilenceChannel` refuses to
// grant over it for exactly that reason — and removing it would delete their only tool from every
// follow-up because it happens to be spelled like ours. `inertToolsFor` is the one that knows.
export function withoutLoneSilenceTool<T extends { name: string }>(
  cfg: { nativeToolsAllow?: string[] },
  tools: T[],
): T[] {
  return tools.length === 1 &&
    tools[0]?.name === SKIP_REPLY_TOOL &&
    inertToolsFor(cfg).has(SKIP_REPLY_TOOL)
    ? []
    : tools;
}
