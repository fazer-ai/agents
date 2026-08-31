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

export interface CustomerFacingReply {
  // The model said nothing this turn. Callers post no text; what else the turn produced (a queued
  // image, a deferred resolve, a handoff line) is a separate question and still applies.
  silent: boolean;
  // The text to show or deliver, sentinel-free. Empty exactly when `silent` — the two are derived
  // from one strip rather than decided separately, which is what makes `[[SKIP]][[SKIP]]` behave
  // like `[[SKIP]]` instead of falling between the two answers.
  text: string;
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
  const text = raw.split(SENTINEL).join("").trim();
  // Wrapping quotes are a model habit rather than content — the proactive path has tolerated them
  // since it was written — so a reply that is nothing BUT quotes once the token is gone is still the
  // token, and posting `""` ships the marker in a costume. Decided on the unquoted form and
  // returned on the original: stripping quotes from a real reply would be its own data loss.
  // ...and only when the raw reply actually CARRIED the token. A customer asking what an empty
  // string literal looks like gets `""` back, and that is content: tolerating quotes unconditionally
  // would silence a real answer and even report it as token-caused (review round 3).
  const silent = raw.includes(SENTINEL)
    ? text.replace(/^["'`]+|["'`]+$/g, "").trim().length === 0
    : text.length === 0;
  return {
    silent,
    text: silent ? "" : text,
    bySentinel: silent && raw.trim().length > 0,
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
    };
  }
  return customerFacingReply(raw);
}

// The follow-up's silence CHANNEL, as one rule rather than one copy per caller.
//
// The directive (`renderNudge`) asks the model to call `skip_reply`, and `skip_reply` is an
// operator-revocable native tool — so a path that renders the directive without binding the tool
// asks for something that is not there, and a follow-up with nothing to say has to say something.
// That is the leak by another road, which is why this is not left to each call site: there are two
// renderers of that directive (production and the playground simulation), and round 3 of review
// found the second one because round 2 changed the protocol in only the first.
export function withFollowupSilenceChannel<
  T extends { nativeToolsAllow?: string[] },
>(cfg: T): T {
  // undefined ⇒ every native tool is allowed, so there is nothing to widen.
  if (!cfg.nativeToolsAllow) return cfg;
  if (cfg.nativeToolsAllow.includes(SKIP_REPLY_TOOL)) return cfg;
  return {
    ...cfg,
    nativeToolsAllow: [...cfg.nativeToolsAllow, SKIP_REPLY_TOOL],
  };
}
