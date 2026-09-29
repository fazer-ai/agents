// What a model turn may hand to a person, and what counts as the model choosing to say nothing. The
// proactive path can ask for EXACTLY `[[SKIP]]` (an "empty message" instruction yields narrated
// emptiness, non-empty text that would be posted). The memory thread is keyed per contact-inbox, so
// a later reactive turn can reproduce the token; every surface that turns a model message into
// something a person reads therefore speaks it, which is why this is its own module.
const SENTINEL = "[[SKIP]]";

export const FOLLOWUP_SKIP_SENTINEL = SENTINEL;

// The tool that is the follow-up's way of saying nothing, preferred over the token.
export const SKIP_REPLY_TOOL = "skip_reply";

// The tool's OWN acknowledgement, exported so its writer and its reader share one literal rather
// than two copies that drift. It is what the MODEL reads; it is not what identifies the tool.
export const SKIP_REPLY_ACK = "Acknowledged: not replying this turn";

// What identifies the tool, deliberately not text: the ack is public, and a NORMAL result under this
// name (an unmet precondition, by design) read as silence would end the turn without answering the
// customer. `additional_kwargs` is out of reach of any response body; only `skipReplyTool` sets it.
export const SKIP_REPLY_MARK = "fazer_skip_reply";

export interface CustomerFacingReply {
  // The model said nothing this turn. Callers post no text; what else the turn produced (a queued
  // image, a deferred resolve, a handoff line) is a separate question and still applies.
  silent: boolean;
  // The text to show or deliver, sentinel-free. Empty exactly when `silent` — the two are derived
  // from one strip rather than decided separately, which is what makes `[[SKIP]][[SKIP]]` behave
  // like `[[SKIP]]` instead of falling between the two answers.
  text: string;
  // The delivered text still CARRIES the token: editing it out would be data loss, so the caller
  // reports it instead of this module suppressing it.
  carriesToken: boolean;
  // Silence caused by the TOKEN rather than by the model writing nothing. Only the caller knows
  // whether that deserves a line: on the proactive path staying silent is the expected outcome, and
  // on the reactive one a customer is waiting, so silence with no trace reads to the operator like
  // the agent ignoring them.
  bySentinel: boolean;
  // The model WROTE something, deliverable or not (the token, or a narrated "(nada a fazer)"), which
  // every kind of silence above erases into `text: ""`. Kept here so no caller re-reads the model's
  // final text, which `tests/graph/silence.test.ts` fences against.
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
  // "reduces ENTIRELY to the marker" is the whole test, never a strip of the token wherever it
  // appears: `docs/graph.md` rejects editing a real answer (the citation-marker precedent), trading a
  // rare cosmetic leak for silent data loss. Wrapping quotes and repetition are the same reply.
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
  // NOTE: A reply that is ONLY a parenthetical starting with empty/nothing/none (pt-BR + EN) → silence.
  if (/^\((?:empty|vazi|nothing|none|nada|sem|n\/a)[^)]*\)$/i.test(stripped)) {
    return true;
  }
  return false;
}

// THE PROACTIVE RULE: the strip above, plus the narrated-emptiness family, because here the prompt
// DID ask the model to produce nothing and models answer that in prose.
export function proactiveReply(raw: string): CustomerFacingReply {
  if (isNudgeSilent(raw)) {
    // NOTE: `bySentinel` stays honest: a narrated "(vazio)" is silence, but it is not the token.
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
  // A real follow-up still loses a stray token, deliberately unlike the reactive rule: on this
  // path the token can come from our own instruction, while on the reactive side it can only come
  // from a transcript, where editing the answer is the data loss `docs/graph.md` prohibits.
  const drafted = customerFacingReply(raw);
  return {
    ...drafted,
    text: drafted.text.split(SENTINEL).join("").trim(),
    carriesToken: false,
  };
}

// What granting the channel needs to read. Which tools a source actually YIELDS is `buildToolset`'s
// answer; `withoutLoneSilenceTool` asks the assembled list afterwards.
export interface FollowupSilenceConfig {
  nativeToolsAllow?: string[];
  toolPreconditions?: Record<string, unknown>;
  httpToolDefs?: { name: string }[];
}

// The follow-up's silence CHANNEL, as one rule rather than one copy per caller. The directive
// (`renderNudge`) asks for `skip_reply`, an operator-revocable native, so a renderer that does not
// bind it asks for something absent; there are two renderers (production and the playground
// simulation), and both must go through here.
export function withFollowupSilenceChannel<T extends FollowupSilenceConfig>(
  cfg: T,
): T {
  let out = cfg;
  // NOTE: an operator's own tool named `skip_reply` is no reason to stand down: the native name is
  // reserved against every other source even when the native is not built, so theirs is dropped at
  // assembly either way, and standing down would leave the follow-up with NEITHER tool. Giving the
  // operator the name back would break every reader that treats a native name as an identity.
  // NOTE: nothing else is asked here. Whether any tool gets BUILT (a down MCP server is configured
  // yet yields nothing) only the assembled list can answer (`withoutLoneSilenceTool`), so this
  // grants freely. undefined means every native is allowed, so there is nothing to widen.
  if (out.nativeToolsAllow && !out.nativeToolsAllow.includes(SKIP_REPLY_TOOL)) {
    out = {
      ...out,
      nativeToolsAllow: [...out.nativeToolsAllow, SKIP_REPLY_TOOL],
    };
  }
  // NOTE: and unguarded, which granting alone does not buy: preconditions are fail-closed and keyed
  // by name, so an operator condition on `skip_reply` would refuse the call the directive depends on
  // (worst in the playground, which has no conversation attributes to meet it).
  if (out.toolPreconditions && SKIP_REPLY_TOOL in out.toolPreconditions) {
    const { [SKIP_REPLY_TOOL]: _dropped, ...rest } = out.toolPreconditions;
    out = { ...out, toolPreconditions: rest };
  }
  return out;
}

// Whether the tool bound under the silence name is OUR no-op one, which is exactly when the name may
// be read as "this call did nothing". Answered off the GRANT, never off the name: a granted native
// wins the name at assembly, and an ungranted one leaves nothing under it (native names are reserved
// even when not built).
export function inertToolsFor(cfg: {
  nativeToolsAllow?: string[];
}): ReadonlySet<string> {
  const bound =
    cfg.nativeToolsAllow === undefined ||
    cfg.nativeToolsAllow.includes(SKIP_REPLY_TOOL);
  return bound ? new Set([SKIP_REPLY_TOOL]) : new Set<string>();
}

// Which channel the directive may ask for, answered by the toolset actually BUILT. `renderNudge`
// takes this and nothing else. Both conditions are needed: the native is what got bound
// (`inertToolsFor`: the call must be ours and do nothing), and it is really THERE, since
// `withFollowupSilenceChannel` grants without knowing whether another source's MCP server is down.
// Reading the assembled list keeps every renderer from restating the condition.
export function followupSilenceChannel(
  cfg: { nativeToolsAllow?: string[] },
  tools: readonly { name: string }[],
): "tool" | "sentinel" {
  return inertToolsFor(cfg).has(SKIP_REPLY_TOOL) &&
    tools.some((t) => t.name === SKIP_REPLY_TOOL)
    ? "tool"
    : "sentinel";
}

// Whether this tool result is OUR no-op tool reporting that it ran. A name is not an outcome: an
// unmet or unreadable precondition on `skip_reply` returns a NORMAL `ToolMessage` under the same
// name telling the model to carry on, and read by name it would end the turn with no answer. So the
// MARK is the identity, and unrecognised content is not silence: that costs a wrap-up instruction,
// while the opposite polarity costs a customer their answer.
export function skipReplyRan(m: {
  getType: () => string;
  name?: string;
  additional_kwargs?: Record<string, unknown>;
}): boolean {
  if (m.getType() !== "tool" || m.name !== SKIP_REPLY_TOOL) return false;
  return m.additional_kwargs?.[SKIP_REPLY_MARK] === true;
}

// Did this turn choose its own silence (called `skip_reply`), as opposed to an empty completion that
// decided nothing? Bounded at the last human message, which is its whole correctness: the checkpoint
// carries earlier turns, and yesterday's `skip_reply` must not authorise closing today.
// `turnBatches` in ./graph.ts cuts at the same place. The MARK decides, never the name (see
// `skipReplyRan`): a refused precondition answers under that name too.
export function silenceWasChosen(
  messages: readonly {
    getType: () => string;
    name?: string;
    additional_kwargs?: Record<string, unknown>;
  }[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.getType() === "human") return false;
    if (skipReplyRan(m)) return true;
  }
  return false;
}

// Why the silence was chosen. Nothing ever takes a `pending` bot-owned conversation out of there, so
// the reason decides whether a person must see it:
//   acknowledged   nothing to add. The conversation stays as it is.
//   not_for_us     not a real conversation (a DMARC report, a payment notice, a newsletter).
//   needs_human    ours, but the agent cannot resolve it.
// The last two move it to `open` (not `resolved`: the point is that a person SEES it) with a note.
export const SKIP_REPLY_REASONS = [
  "acknowledged",
  "not_for_us",
  "needs_human",
] as const;
export type SkipReplyReason = (typeof SKIP_REPLY_REASONS)[number];

// Beside the mark and for the same reason: only the tool that builds the `ToolMessage` can set it.
export const SKIP_REPLY_REASON_KEY = "fazer_skip_reason";
export const SKIP_REPLY_DETAIL_KEY = "fazer_skip_detail";

// Severity, so that two skips in one turn resolve to the one that asks for a person.
const REASON_WEIGHT: Record<SkipReplyReason, number> = {
  acknowledged: 0,
  not_for_us: 1,
  needs_human: 2,
};

function readReason(v: unknown): SkipReplyReason | null {
  return typeof v === "string" &&
    (SKIP_REPLY_REASONS as readonly string[]).includes(v)
    ? (v as SkipReplyReason)
    : null;
}

// The reason THIS turn chose its silence for, with the same bound and mark as `silenceWasChosen`:
// null exactly when that answers false. A marked line with no reason reads as `acknowledged`, the
// reading that changes nothing about the conversation.
export function chosenSilence(
  messages: readonly {
    getType: () => string;
    name?: string;
    additional_kwargs?: Record<string, unknown>;
  }[],
): { reason: SkipReplyReason; detail: string | null } | null {
  let best: { reason: SkipReplyReason; detail: string | null } | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.getType() === "human") break;
    if (!skipReplyRan(m)) continue;
    const reason =
      readReason(m.additional_kwargs?.[SKIP_REPLY_REASON_KEY]) ??
      "acknowledged";
    const raw = m.additional_kwargs?.[SKIP_REPLY_DETAIL_KEY];
    const detail = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    if (!best || REASON_WEIGHT[reason] > REASON_WEIGHT[best.reason])
      best = { reason, detail };
  }
  return best;
}

// Our protocol tool is never the only tool a FOLLOW-UP binds. A list of just `skip_reply` means the
// agent is tool-less in practice (a plain chat model, or an `openai-compatible` endpoint that answers
// 400 to any function schema), and one no-op tool there would make the follow-up fail instead of a
// token leaking; `followupSilenceChannel` then answers `sentinel`. Follow-up only: a reactive turn
// keeps a lone granted `skip_reply`, which is how an agent answers "ok" with silence. Whether the
// lone tool is ours is read off the grant (`inertToolsFor`), never off the name.
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
