// What a model turn may hand to a customer, and what counts as the model choosing to say nothing.
//
// The rule exists because the proactive path ASKS for a token. A follow-up that decides not to
// write is told to answer with EXACTLY `[[SKIP]]`, because "reply with an empty message" produces
// narrated emptiness instead ("(empty — nothing to do yet)"), and that narration is non-empty text
// that would be posted. So the token is the follow-up's vocabulary, and every path that turns a
// model message into something a person reads has to speak it.
//
// It lives in its own module, and not next to the follow-up that invented it, because the path that
// LEAKED it is the reactive one (issue #454): the memory thread is keyed per contact-inbox, so
// every silent follow-up leaves an assistant turn whose whole content is the token, and a later
// ordinary turn for the same contact can reproduce it. Delivered verbatim on an email inbox, that
// is a real email to whoever wrote in. One definition, imported by the four sites, instead of a
// rule that two of them happened to know.
const SENTINEL = "[[SKIP]]";

export const FOLLOWUP_SKIP_SENTINEL = SENTINEL;

// True when the model declined to write: empty, the skip sentinel (tolerating wrapping quotes), a
// bare "SKIP", or a parenthetical-only "narrated emptiness" (the failure mode the sentinel exists
// for, and which still arrives on its own).
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

export interface CustomerFacingReply {
  // The model said nothing this turn. Callers post no text; what else the turn produced (a queued
  // image, a deferred resolve, a handoff line) is a separate question and still applies.
  silent: boolean;
  // The text to deliver, sentinel-free. Empty exactly when `silent`.
  text: string;
  // The reply reduced to silence because of the TOKEN, not because the model wrote nothing. Only
  // the caller knows whether that deserves a line — on the proactive path staying silent is the
  // expected outcome, and on the reactive one a customer is waiting, so silence with no trace reads
  // to the operator like the agent ignoring them.
  bySentinel: boolean;
}

// The one rule. A reply that REDUCES to the token is silence; a real reply that merely carries it
// keeps its text and loses the token, because suppressing the whole message there would trade a
// leaked marker for an ignored customer.
export function customerFacingReply(raw: string): CustomerFacingReply {
  if (isNudgeSilent(raw)) {
    return { silent: true, text: "", bySentinel: raw.trim().length > 0 };
  }
  return {
    silent: false,
    text: raw.split(SENTINEL).join("").trim(),
    bySentinel: false,
  };
}
