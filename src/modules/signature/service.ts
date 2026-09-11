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

export interface SignatureConfig {
  // "" is both the default and the off switch.
  text: string;
  position: SignaturePosition;
  separator: SignatureSeparator;
}

export const SIGNATURE_DEFAULTS: SignatureConfig = {
  text: "",
  position: "top",
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
  return {
    // Clamped like every other operator-authored field in the bag: the row keeps what was written
    // and only the copy that reaches the customer is bounded (see modules/agents/text-caps.ts).
    text:
      typeof bag.text === "string"
        ? clipText(bag.text.trim(), SIGNATURE_MAX)
        : SIGNATURE_DEFAULTS.text,
    position:
      bag.position === "top" || bag.position === "bottom"
        ? bag.position
        : SIGNATURE_DEFAULTS.position,
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
// So the first version is one text and an empty string for off, and the second one, if it is ever
// needed, is `signature.channels: { "Channel::Whatsapp": {...} }` with this as the default.
export function signatureFor(
  cfg: SignatureConfig,
  vars?: Record<string, string>,
  opts?: PromptRenderOpts,
): string | null {
  if (!cfg.text) return null;
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
// in the prose — "Gi" in a sentence about Gi — as one already written, and silently drops it.
//
// ASKED ACROSS THE WHOLE REPLY, the text as it arose rather than any view of it, and BOTH ends
// rather than only the configured one.
//
// THE WHOLE REPLY, not the chunks, because the split is LOSSY for this question and twice over.
// A signature containing a blank line is cut by the same paragraph rule, so neither edge chunk holds
// all of it: `Resposta.\n\n— Gi\n\nGuichê Web` against `— Gi\n\nGuichê Web` matched nothing and the
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
  return text.startsWith(s) || text.endsWith(s);
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
// Pure, and the single spelling of the rule: a caller that sends one message passes `[text]`.
export function attachSignature(
  chunks: string[],
  signature: string | null,
  position: SignaturePosition,
  separator: SignatureSeparator,
  // The reply AS IT AROSE, before the split. Only the dedupe reads it (see `alreadySigned`); the
  // attachment still happens on a chunk, which is the whole design.
  whole?: string,
): string[] {
  if (!signature || chunks.length === 0) return chunks;
  // Nothing was said, so nothing is signed. With split ON the splitter already trims a whitespace
  // reply to zero chunks; with split OFF the same reply arrives here as one blank chunk, and without
  // this the two paths would disagree about the same silent turn.
  if (chunks.every((c) => c.trim().length === 0)) return chunks;
  const delimiter = DELIMITERS[separator];
  const i = position === "top" ? 0 : chunks.length - 1;
  const chunk = chunks[i];
  if (chunk === undefined || alreadySigned(chunks, signature, whole))
    return chunks;
  const out = [...chunks];
  out[i] =
    position === "top"
      ? `${signature}${delimiter}${chunk.trimStart()}`
      : `${chunk.trimEnd()}${delimiter}${signature}`;
  return out;
}
