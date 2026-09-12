// THE OPERATOR'S SIGNATURE, written by configuration and never by the model (issue #599). Measured
// over three rounds of the same twelve real customer emails: asked for in the prompt, `gpt-5.6-luna`
// glued the closing to the last sentence in 2 of 10 replies, and left it out of 3 of 3 handoffs —
// `handoff_to_human`'s schema asks for "a brief reply to the customer" and the schema wins over the
// system prompt. A signature is the kind of text that must be identical every time, and anything the
// model writes varies.
//
// THE VOCABULARY IS CHATWOOT'S, deliberately. The fork already stores per-inbox signatures
// (`inbox_signatures`, our own PR #226) with `message_signature`, `signature_position` and
// `signature_separator`, and applies them in the reply box with `appendSignature`. None of that
// logic is reusable here — the table is `belongs_to :user` and an agent bot is not a User, and the
// application is frontend-only, so nothing a bot posts through the API passes through it — but an
// operator who configures both should meet the same words, the same bytes and the same defaults in
// both places, `top` included.

import { interpolatePromptVars, type PromptRenderOpts } from "@/graph/prompt";
import { clipText } from "@/lib/text";
import { SIGNATURE_MAX } from "@/modules/agents/text-caps";

export type SignaturePosition = "top" | "bottom";
export type SignatureSeparator = "blank" | "--";
export type SignatureFrequency = "all" | "once";

export interface SignatureConfig {
  // THE OFF SWITCH, and a switch rather than an empty field (#612). The first version made
  // `text: ""` the only way to be off, so turning the signature off DESTROYED the text the operator
  // would have to retype to turn it back on, and the text is the part that took thought to write.
  // Every other block on the Behavior tab is a toggle over fields that keep their values.
  enabled: boolean;
  // Still empty by default: `enabled` says whether to sign, this says what with. Both have to be
  // answered before a customer sees anything, so an enabled block with no text signs nothing, and
  // that is an operator who has not finished rather than an error.
  text: string;
  position: SignaturePosition;
  separator: SignatureSeparator;
  // POSITION AND REPETITION ARE THE SAME DECISION SEEN FROM TWO SIDES (#616), and the first version
  // answered only one of them. A signature at the BOTTOM is a farewell: said once, at the end, and
  // repeating it on four balloons in ten seconds is worse than not having it. A signature at the TOP
  // is a badge, and the question a badge answers, "who is talking to me", comes back on EVERY
  // balloon, because on WhatsApp each balloon is an independent message with its own notification,
  // its own preview and its own forward. #599 offered `top` and then treated it as a farewell.
  //
  // The two fields stay independent rather than being folded into one, because the cross
  // combinations are real: a badge only on the opening balloon is a legitimate choice for an
  // operator who wants to introduce the agent once and then stop repeating itself.
  frequency: SignatureFrequency;
}

export const SIGNATURE_DEFAULTS: SignatureConfig = {
  enabled: false,
  text: "",
  position: "top",
  // Derived from the position above, and it has to match it: see the reader, where the same
  // derivation answers a bag that never wrote the field.
  frequency: "all",
  separator: "blank",
};

// Byte-identical to Chatwoot's own delimiters (`appendSignature` in dashboard/helper/editorHelper.js).
const DELIMITERS: Record<SignatureSeparator, string> = {
  blank: "\n\n",
  "--": "\n\n--\n\n",
};

export function readSignatureConfig(settings: unknown): SignatureConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).signature
      : undefined;
  if (!s || typeof s !== "object") return { ...SIGNATURE_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const position =
    bag.position === "top" || bag.position === "bottom"
      ? bag.position
      : SIGNATURE_DEFAULTS.position;
  return {
    // A BAG WRITTEN BEFORE THE SWITCH EXISTED MEANT ON, and reading its absence as off would unsign
    // every agent configured under #599 on the next load, silently, with nobody touching anything.
    // That is the same class of loss the switch exists to prevent, so the fallback reads the only
    // signal such a bag carries: whether there is anything to sign with. A flag of another shape is
    // not an answer either, and falls back the same way every other field here does.
    enabled:
      typeof bag.enabled === "boolean"
        ? bag.enabled
        : typeof bag.text === "string" && bag.text.trim() !== "",
    // Clamped like every other operator-authored field in the bag: the row keeps what was written
    // and only the copy that reaches the customer is bounded (see modules/agents/text-caps.ts).
    text:
      typeof bag.text === "string"
        ? clipText(bag.text.trim(), SIGNATURE_MAX)
        : SIGNATURE_DEFAULTS.text,
    position,
    // READ OFF THE POSITION when the bag never wrote it, which is every bag written before #616.
    // The position is where the operator's intent is already visible — a badge above, a farewell
    // below — so the default reads it instead of asking the same question twice, and an operator
    // who wants the cross combination says so explicitly.
    //
    // This is a BEHAVIOUR CHANGE on deploy for an agent already configured with `position: "top"`:
    // one signed balloon becomes all of them, with nobody touching the agent. Declared in the issue
    // rather than discovered, and narrow because the feature is off by default and shipped the day
    // before. The alternative, defaulting an old bag to `once`, would have every existing top
    // signature keep doing the thing the operator reported as wrong.
    frequency:
      bag.frequency === "all" || bag.frequency === "once"
        ? bag.frequency
        : position === "top"
          ? "all"
          : "once",
    separator:
      bag.separator === "blank" || bag.separator === "--"
        ? bag.separator
        : SIGNATURE_DEFAULTS.separator,
  };
}

// THE SIGNATURE FOR THIS TURN, or null when the feature is off. One channel-agnostic text, on every
// channel the agent answers on.
//
// NO PER-CHANNEL SWITCH, and the shape it would take later is why. A filter — "sign these classes" —
// answers only half the question an operator actually has, because the OTHER half is that a closing
// written for e-mail is not the closing they want on WhatsApp. The version that answers both is a
// signature PER CHANNEL, which is what the Chatwoot fork already does per inbox, and a channels
// allowlist is not a step toward it: it is a different field that would have to be migrated away.
// So the first version is one text behind one switch, and the second one, if it is ever needed, is
// `signature.channels: { "Channel::Whatsapp": {...} }` with this as the default. The `enabled` flag
// is not the second off switch that argument refuses: an empty allowlist preserves nothing and
// answers a different question, while `enabled` preserves the text, which is the point (#612).
export function signatureFor(
  cfg: SignatureConfig,
  vars?: Record<string, string>,
  opts?: PromptRenderOpts,
): string | null {
  // Both halves, and `trim` rather than truthiness: a text of only spaces is nothing to sign with,
  // and this function is called with configs the reader has not necessarily trimmed.
  if (!cfg.enabled || !cfg.text.trim()) return null;
  return interpolate(cfg.text, vars, opts);
}

// THE SAME PLACEHOLDERS THE SYSTEM PROMPT TAKES, through the same function — `{{nome_agente}}`,
// `{{nome_empresa}}`, `{{nome_contato}}` and the rest of `buildPromptVars`, in their pt-BR and EN
// spellings alike. Not a second syntax invented for this field: an operator who has learned the
// prompt's `{{var}}` has learned this one, the editor highlights a real name against a typo with the
// prompt's own known-token set, and a name added to the prompt reaches here without anyone
// remembering to. `interpolatePromptVars` leaves an unknown placeholder untouched rather than
// blanking it, which is what makes a typo visible instead of silently deleting the operator's text.
// The OPTIONS travel with the map, and they have to: `interpolatePromptVars` answers a schedule or
// time variable from `opts` (the agent's timezone, the instant, the business-hours grid), so a
// caller that passes only the map renders `{{horario_atendimento}}` literally on every message the
// customer receives. Found in review of #599, on the reading that the doc promises the prompt's
// placeholders and the code delivered a subset of them.
function interpolate(
  text: string,
  vars?: Record<string, string>,
  opts?: PromptRenderOpts,
): string {
  return vars ? interpolatePromptVars(text, vars, opts ?? {}) : text;
}

// Whether this reply already carries the signature, asked at the two ENDS it could occupy.
//
// A TAIL CHECK, NOT CONTAINMENT, which is Chatwoot's own rule (`findSignatureInBody` is
// `trimmedBody.endsWith(cleanedSignature)`). Containment reads a short signature that merely appears
// in the prose, "Alex" in a sentence about Alex, as one already written, and silently drops it.
// Chatwoot's own version is missing the line boundary below, which is why it also drops the
// signature from a reply that merely starts with the same letters.
//
// ASKED ACROSS THE WHOLE REPLY, the text as it arose rather than any view of it, and BOTH ends
// rather than only the configured one.
//
// THE WHOLE REPLY, not the chunks, because the split is LOSSY for this question and twice over.
// A signature containing a blank line is cut by the same paragraph rule, so neither edge chunk holds
// all of it: `Resposta.\n\nAlex\n\nMinha Empresa` against `Alex\n\nMinha Empresa` matched nothing and the
// customer read two closings. Reassembling from `seps` fixed that one and not the second, which
// review found next: `splitReplyParts` TRIMS each paragraph, so a signature with an indented line
// comes back without the indentation and the comparison fails again. The caller that splits has the
// original in hand, so it passes it; there is nothing to reconstruct. (The `\n\n` join is the
// fallback for a chunk array assembled by hand in a test, and it can only make the check stricter.) With `position: "top"` the signature goes on the FIRST chunk, and a
// model that signed itself at the end put its copy on the LAST one: a check scoped to chunk zero
// finds nothing, prepends, and the customer reads two closings. Asking both ends leaves ONE
// signature, at the end the model chose — so `position` is where WE place a signature, not a promise
// about where one the model wrote will end up. One in the wrong place beats two in the right one.
//
// What this does NOT catch, and it has to be said rather than implied: it de-duplicates an exact
// repetition. A model that writes its own VARIANT of the closing still produces two, and the fix for
// that is the prompt, which this feature exists to empty. Chatwoot has the same limit.
export function alreadySigned(
  chunks: string[],
  signature: string,
  whole?: string,
): boolean {
  const s = signature.trim();
  if (!s || chunks.length === 0) return false;
  const text = (whole ?? chunks.join("\n\n")).trim();
  if (text === s) return true;
  // ON A LINE BOUNDARY, or it is not the signature. A bare `startsWith` reads any reply whose first
  // word merely begins with it as signed: "Ana" against "Analisei o seu pedido" matched, and the
  // customer got a reply with no closing at all, which is the failure this whole feature exists to
  // prevent, produced by the guard against its twin. Round 12 of the review. A short signature is a
  // first name, so this is the common case and not an exotic input. The boundary is a line break
  // rather than the separator's full "\n\n": a model writing its own closing need not leave a blank
  // line, and the question is whether that LINE is the signature, not how it was spaced.
  if (text.startsWith(s) && text[s.length] === "\n") return true;
  return text.endsWith(s) && text[text.length - s.length - 1] === "\n";
}

// THE SAME CUT `splitReplyParts` MAKES, and the same trim, because everything this module compares
// a balloon against has been through it. Kept in one place: the two callers below would otherwise
// be two spellings of the splitter's rule, and a module whose whole subject is what the split does
// to a signature cannot afford a second, drifting copy of it.
function paragraphsOf(signature: string): string[] {
  return signature
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// The signature as the splitter would have left it: paragraphs trimmed, rejoined with a plain
// blank line, which is exactly what the `maxChunks` merge does to the model's own copy.
function normalizeParagraphs(signature: string): string {
  return paragraphsOf(signature).join("\n\n");
}

// WHICH BALLOONS ARE THE MODEL'S OWN COPY, when the signature it wrote SPANS A BLANK LINE.
//
// This is #599's split-boundary defect seen from the other side. A signature containing a blank
// line is cut by the same paragraph rule the reply is, so its copy occupies several balloons and no
// single one holds all of it: the per-balloon check recognises none of them, and every fragment
// would come back with a second signature glued to it. Found in review round 1 of #617, which is
// the second time this exact property has bitten this module.
//
// TWO QUESTIONS, and only the first can be asked of the reply as a whole. `alreadySigned` answers
// WHETHER there is a copy, and it is the only thing that can, because the split is lossy. A balloon
// that is ENTIRELY one paragraph of the signature then answers WHICH, on its own, without a
// position and without a run: a balloon whose whole body is a piece of the closing is not something
// the customer reads as content, so a second signature on it is only noise.
//
// A balloon that holds content AND a fragment is not one of these, and is signed like any other.
// That case is the model gluing its closing to the last line of prose, and suppressing the
// signature on a balloon the customer reads as content is the failure this whole feature exists to
// prevent — so the worst case here stays a second signature, never a missing one. Round 2 of the
// same review asked for the fragment to be matched as a line-bounded suffix instead; that rule
// would have skipped the balloon carrying "Resposta." along with the fragment glued to it.
//
// The `alreadySigned` gate is what keeps this off prose. A balloon reading exactly "Alex" in a
// reply the model never signed is a paragraph of the operator's own text, and it gets the
// signature like every other.
function copyRun(
  chunks: string[],
  signature: string,
  whole?: string,
): Set<number> {
  const out = new Set<number>();
  const parts = paragraphsOf(signature);
  // One paragraph is the per-balloon check's own case, and it answers it better: with the line
  // boundary, against the balloon as it stands.
  if (parts.length < 2) return out;
  if (!alreadySigned(chunks, signature, whole)) return out;
  chunks.forEach((c, i) => {
    if (parts.includes(c.trim())) out.add(i);
  });
  return out;
}

// ATTACHES TO A CHUNK, and that is the whole design. `deliverReply` cuts the reply on /\n{2,}/, and
// BOTH separators contain "\n\n" — so a signature concatenated onto the text BEFORE the cut becomes
// its own balloon with `blank`, and with `--` it becomes a balloon whose entire body is `--`. At the
// `maxChunks` ceiling it is instead merged into the last paragraph, which means one configuration
// renders two different ways depending on how long the reply happened to be. On an email inbox with
// split on, each balloon is an email, so one of them is an email whose whole body is the signature.
//
// It also answers the silent turn for free. A reply of only whitespace is truthy, so it passes the
// runtime's `if (!reply)` gate, and the splitter trims it to ZERO chunks — nothing is sent today.
// Attaching to a chunk that does not exist attaches nothing, where appending to the text would have
// made the signature a lone message in a turn where the agent said nothing.
//
// Pure, and the single spelling of the rule: a caller that sends one message passes `[text]`, which
// is also why `all` and `once` are indistinguishable on the three single-message sends (split off,
// the handoff's farewell on the proactive path, the follow-up). One chunk is one signature either
// way, so the repetition cannot leak into a path that never splits.
export function attachSignature(
  chunks: string[],
  signature: string | null,
  // THE CONFIG, not three loose arguments, since #616 added the third. A caller that passes the
  // agent's `signatureConfig` straight through cannot forget one of them, and forgetting the
  // frequency is the mistake that silently reverts this feature at one send site out of four.
  cfg: Pick<SignatureConfig, "position" | "separator" | "frequency">,
  // The reply AS IT AROSE, before the split. Only the dedupe reads it (see `alreadySigned`); the
  // attachment still happens on a chunk, which is the whole design.
  whole?: string,
): string[] {
  if (!signature || chunks.length === 0) return chunks;
  // Nothing was said, so nothing is signed. With split ON the splitter already trims a whitespace
  // reply to zero chunks; with split OFF the same reply arrives here as one blank chunk, and without
  // this the two paths would disagree about the same silent turn.
  if (chunks.every((c) => c.trim().length === 0)) return chunks;
  const { position, separator, frequency } = cfg;
  const delimiter = DELIMITERS[separator];
  const put = (chunk: string): string =>
    position === "top"
      ? `${signature}${delimiter}${chunk.trimStart()}`
      : `${chunk.trimEnd()}${delimiter}${signature}`;
  // EVERY MESSAGE OF THE TURN, which is a loop over the same rule and not a second one. The balloon
  // COUNT is the invariant it must not touch: `deliverReply` keeps `seps` aligned with `chunks` by
  // index, so a signature that added or merged a balloon would misalign every pause after it.
  if (frequency === "all") {
    // ASKED PER BALLOON, and that is the shape change the repetition forces. `alreadySigned` asks
    // about the reply as it AROSE, at both ends, which is the right question for `once` and the
    // wrong one here: a model that signed itself at the end would suppress the badge on every other
    // balloon, which is the failure this feature exists to prevent, produced by the guard against
    // its twin. The rule inside the balloon is unchanged, line boundary included.
    const own = copyRun(chunks, signature, whole);
    // ASKED TWICE, of the signature as written and of the signature PUT THROUGH THE SPLITTER'S OWN
    // NORMALISATION. At the `maxChunks` ceiling the overflow is merged back into the last balloon
    // with a plain "\n\n" after each paragraph was trimmed, so a signature with an indented line
    // arrives there without its indentation and matches nothing. `once` survives that because it
    // asks the original; a per-balloon question cannot, so it compares like with like instead.
    // Round 3 of the review, and the third time the trimming invariant has bitten this module.
    const asSplit = normalizeParagraphs(signature);
    return chunks.map((c, i) =>
      c.trim().length === 0 ||
      own.has(i) ||
      alreadySigned([c], signature) ||
      alreadySigned([c], asSplit)
        ? c
        : put(c),
    );
  }
  const i = position === "top" ? 0 : chunks.length - 1;
  const chunk = chunks[i];
  if (chunk === undefined || alreadySigned(chunks, signature, whole))
    return chunks;
  const out = [...chunks];
  out[i] = put(chunk);
  return out;
}
