// The operator's signature, written by configuration and never by the model: a signature must be
// identical every time, and model text varies (a tool schema such as `handoff_to_human`'s also wins
// over the system prompt and drops it).
//
// The vocabulary, bytes and defaults are Chatwoot's per-inbox signature (`inbox_signatures`,
// `appendSignature`), so an operator meets the same words in both places. That code cannot be reused:
// it belongs to a User (a bot is not one) and runs only in the frontend. See docs/signature.md.

import { interpolatePromptVars, type PromptRenderOpts } from "@/graph/prompt";
import { clipText } from "@/lib/text";
import { SIGNATURE_MAX } from "@/modules/agents/text-caps";
import {
  isOneOf,
  SIGNATURE_FREQUENCIES,
  SIGNATURE_POSITIONS,
  SIGNATURE_SEPARATORS,
  type SignatureFrequency,
  type SignaturePosition,
  type SignatureSeparator,
} from "@/modules/signature/domains";

export type { SignatureFrequency, SignaturePosition, SignatureSeparator };

export interface SignatureConfig {
  // A switch rather than an empty `text`, so turning the signature off keeps the text the operator
  // would otherwise have to retype.
  enabled: boolean;
  // Empty by default: an enabled block with no text signs nothing, which is an operator who has not
  // finished rather than an error.
  text: string;
  position: SignaturePosition;
  separator: SignatureSeparator;
  // A bottom signature is a farewell (said once); a top one is a badge, repeated on every balloon
  // because each WhatsApp balloon is an independent message. Kept independent of `position` because
  // the cross combinations (a badge only on the opening balloon) are legitimate.
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
  const position = isOneOf(SIGNATURE_POSITIONS, bag.position)
    ? bag.position
    : SIGNATURE_DEFAULTS.position;
  return {
    // NOTE: a bag without `enabled` predates the switch and meant on; reading its absence as off
    // would silently unsign those agents, so the fallback is whether there is text to sign with.
    enabled:
      typeof bag.enabled === "boolean"
        ? bag.enabled
        : typeof bag.text === "string" && bag.text.trim() !== "",
    // NOTE: the row keeps what was written; only the copy that reaches the customer is bounded
    // (see modules/agents/text-caps.ts).
    text:
      typeof bag.text === "string"
        ? clipText(bag.text.trim(), SIGNATURE_MAX)
        : SIGNATURE_DEFAULTS.text,
    position,
    // NOTE: a bag without `frequency` reads it off the position (badge above, farewell below).
    // Defaulting such a bag to `once` would keep a top signature on only one balloon, which is wrong
    // for a badge.
    frequency: isOneOf(SIGNATURE_FREQUENCIES, bag.frequency)
      ? bag.frequency
      : position === "top"
        ? "all"
        : "once",
    separator: isOneOf(SIGNATURE_SEPARATORS, bag.separator)
      ? bag.separator
      : SIGNATURE_DEFAULTS.separator,
  };
}

// The signature for this turn, or null when the feature is off. One text on every channel: a
// channels allowlist is deliberately absent, since the real next step is a signature per channel
// (docs/signature.md).
export function signatureFor(
  cfg: SignatureConfig,
  vars?: Record<string, string>,
  opts?: PromptRenderOpts,
): string | null {
  // NOTE: `trim` rather than truthiness, since callers may pass configs the reader never trimmed.
  if (!cfg.enabled || !cfg.text.trim()) return null;
  return interpolate(cfg.text, vars, opts);
}

// The system prompt's placeholders, through the same function, so a name added to the prompt
// reaches here too; an unknown one is left standing so a typo stays visible. `opts` must travel with
// the map: schedule and time variables are answered from it, and without it they render literally.
function interpolate(
  text: string,
  vars?: Record<string, string>,
  opts?: PromptRenderOpts,
): string {
  return vars ? interpolatePromptVars(text, vars, opts ?? {}) : text;
}

// Whether this reply already carries the signature, at either end and on a line boundary: a tail
// check rather than containment (Chatwoot's rule), so "Alex" inside the prose is not a signature.
// Asked of `whole`, the reply as it arose: the split cuts and trims a signature, so edge chunks
// cannot answer. Both ends, since `position` is where WE sign, not where the model did. Only an exact
// repetition is caught; a model's own variant of the closing still yields two.
export function alreadySigned(
  chunks: string[],
  signature: string,
  whole?: string,
): boolean {
  const s = signature.trim();
  if (!s || chunks.length === 0) return false;
  const text = (whole ?? chunks.join("\n\n")).trim();
  if (text === s) return true;
  // NOTE: on a line boundary, or "Ana" would match "Analisei o seu pedido" and the reply would go out
  // unsigned. A single "\n", not the separator's "\n\n": a model's own closing need not leave a blank line.
  if (text.startsWith(s) && text[s.length] === "\n") return true;
  return text.endsWith(s) && text[text.length - s.length - 1] === "\n";
}

// Every way the splitter can cut, trim, merge or rejoin the model's own copy differs from what it
// wrote only in WHITESPACE, so this is the one normalisation everything below compares through.
function flatten(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// The same idea for a single balloon, where line breaks must survive: the `maxChunks` merge only drops
// indentation and blank lines, and keeping the breaks stops "Alex\nSupport" equalling "Alex Support".
function normalizeLines(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

// Which balloons hold the model's own copy when the splitter took it apart. Every way the split cuts
// a signature differs only in whitespace, so from each end that `alreadySigned` confirms, walk inward
// over balloons that are still a prefix/suffix of the flattened signature, stopping at the first that
// is not: a balloon with content keeps its signature (worst case two, never none). The gate keeps the
// walk off prose. See docs/signature.md.
function copyRun(
  chunks: string[],
  signature: string,
  whole?: string,
): Set<number> {
  const out = new Set<number>();
  const s = signature.trim();
  const target = flatten(s);
  if (!target) return out;
  const text = (whole ?? chunks.join("\n\n")).trim();
  // NOTE: `alreadySigned`'s two comparisons, split by end. Both ends walk when both say yes (a model
  // that opened and closed with the line wrote two copies); the reply decides, not the config.
  const atStart = text === s || (text.startsWith(s) && text[s.length] === "\n");
  const atEnd =
    text === s ||
    (text.endsWith(s) && text[text.length - s.length - 1] === "\n");
  for (const fromStart of [true, false]) {
    if (fromStart ? !atStart : !atEnd) continue;
    let acc = "";
    const order = fromStart
      ? chunks.map((_, i) => i)
      : chunks.map((_, i) => chunks.length - 1 - i);
    for (const i of order) {
      // A balloon already claimed by the other end cannot also belong to this one.
      if (out.has(i)) break;
      const piece = flatten(chunks[i] ?? "");
      if (!piece) break;
      acc = fromStart
        ? acc
          ? `${acc} ${piece}`
          : piece
        : acc
          ? `${piece} ${acc}`
          : piece;
      if (!(fromStart ? target.startsWith(acc) : target.endsWith(acc))) break;
      out.add(i);
      if (acc === target) break;
    }
  }
  return out;
}

// Attaches to already-split chunks, never to the text: both separators contain "\n\n", which the
// splitter cuts on, so a pre-split signature would become its own balloon. Zero chunks (a whitespace
// reply) attach nothing. A single-message send passes `[text]`, so `all` and `once` coincide there.
export function attachSignature(
  chunks: string[],
  signature: string | null,
  // The config object rather than loose arguments, so a send site cannot forget the frequency.
  cfg: Pick<SignatureConfig, "position" | "separator" | "frequency">,
  // The reply as it arose, before the split; only the dedupe reads it.
  whole?: string,
): string[] {
  if (!signature || chunks.length === 0) return chunks;
  // NOTE: with split off a whitespace reply arrives as one blank chunk; this keeps it unsigned, as the
  // split path's zero chunks are.
  if (chunks.every((c) => c.trim().length === 0)) return chunks;
  const { position, separator, frequency } = cfg;
  const delimiter = DELIMITERS[separator];
  const put = (chunk: string): string =>
    position === "top"
      ? `${signature}${delimiter}${chunk.trimStart()}`
      : `${chunk.trimEnd()}${delimiter}${signature}`;
  // NOTE: the balloon count must not change: `deliverReply` aligns `seps` with `chunks` by index.
  if (frequency === "all") {
    // NOTE: asked per balloon, not of the whole reply: a model that signed at the end would
    // otherwise suppress the badge on every other balloon.
    const own = copyRun(chunks, signature, whole);
    // NOTE: a whole copy can share a balloon with prose after the `maxChunks` merge, which trims
    // indentation. Matched on whole lines at an end, never in the middle: containment is how a
    // balloon loses its own closing ("Alex Support can help" is not "Alex\nSupport").
    const sigLines = normalizeLines(signature);
    const sigCount = sigLines.split("\n").length;
    const endRunMatches = (t: string): boolean => {
      const lines = normalizeLines(t).split("\n");
      if (lines.length < sigCount) return false;
      return (
        lines.slice(0, sigCount).join("\n") === sigLines ||
        lines.slice(lines.length - sigCount).join("\n") === sigLines
      );
    };
    // NOTE: gated on the reply having a copy at all; ungated, two ordinary lines (a list, an address)
    // matching the signature would send a balloon unsigned.
    const signedSomewhere =
      alreadySigned(chunks, signature, whole) ||
      endRunMatches(whole ?? chunks.join("\n\n"));
    const flatSigned = (c: string): boolean =>
      signedSomewhere && endRunMatches(c);
    return chunks.map((c, i) =>
      c.trim().length === 0 ||
      own.has(i) ||
      alreadySigned([c], signature) ||
      flatSigned(c)
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
