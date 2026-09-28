import { clipText, makeStorable } from "@/lib/text";

// Non-throwing secret redaction for human-facing debug surfaces (the agent playground trace and
// the conversation `lastError`): the REPLACE-and-continue cousin of n8n-export's `assertNoSecrets`,
// which THROWS as an export backstop. Two layers: values under credential-named KEYS are dropped
// wholesale, and secret-shaped VALUE substrings are scrubbed in place. The playground trace never
// carries a RESOLVED credential (those go only into request headers), so this is defense-in-depth.

const REDACTED = "‹redacted›";

// High-confidence secret VALUE shapes (global flags: scrub every occurrence, not just the first).
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /(?:bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, // Authorization header material
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style keys
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
  // NOTE: a JWT HEAD that runs to the end of the scanned window. The other shapes are a prefix plus
  // a run, so a long enough piece still matches; a cut JWT is missing STRUCTURE (two dots and a last
  // segment), which no scan margin restores, so it is recognised by its head. Anchored at the end,
  // where a cut leaves it, so a mid-sentence base64 blob starting with `eyJ` is not redacted. The
  // complete-token pattern above runs first.
  /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*)*$/g, // JWT truncated by a cut
];

// Object keys whose VALUE is a credential and must be dropped wholesale.
const SECRET_KEY_RE =
  /(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|authorization|secret|credential)/i;

export const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

const TRUNCATED = "…[truncated]";

// Truncates a string to `max` chars, appending a visible marker so a reader knows it was cut.
export function truncate(s: string, max = MAX_STRING): string {
  return s.length > max ? `${clipText(s, max)}${TRUNCATED}` : s;
}

// How far PAST the cut the scrub reads, and the number is a floor with room on top.
//
// Every value pattern has a minimum length and none has a maximum, so a long enough PREFIX of a
// credential still matches — which is what makes a margin sufficient at all. The longest minimum is
// the JWT shape at 31 characters (`eyJ` + 10, a dot, 10, a dot, 6), so a token starting anywhere at
// or before the cut keeps enough of itself to be recognised.
const SECRET_SCAN_MARGIN = 64;

// HOW MUCH SOURCE TO TAKE so the repaired window is `need` characters long. `makeStorable` DELETES
// every NUL, so a source window of `need` characters comes back shorter by its NUL count, and enough
// NULs would spend the whole scan margin and let a token cut before the scrub be stored raw. Counted
// exactly (only NULs shrink); the walk stops at `need` plus the NULs in front of it.
function sourceFor(value: string, need: number): number {
  let end = 0;
  let kept = 0;
  while (kept < need && end < value.length) {
    if (value.charCodeAt(end) !== 0) kept++;
    end++;
  }
  return end;
}

// REPAIR, SCRUB, THEN CUT: the one order, in one place, because every surface storing a third
// party's text needs all three and the other orders leak. Cut first, a credential's prefix falls
// under its pattern's minimum and is stored raw. Repair after the scrub, a token hidden by a NUL
// (`sk-<NUL>abcd…`) comes back whole once the NUL is deleted. The scan reads only the cut plus
// `SECRET_SCAN_MARGIN`, so a 10 MB tool result is not scanned to store two thousand characters.
export function scrubbedClip(
  value: string,
  max: number,
  scan = max + SECRET_SCAN_MARGIN,
): string {
  const repaired = makeStorable(clipText(value, sourceFor(value, scan)));
  const scanned = redactSecretsInText(repaired);
  // Marked as cut when the window held more than the cut keeps — and the window is never narrower
  // than the cut (`scan` starts at `max` plus a margin, and the error path passes the whole input),
  // so a window that stopped short of the end always overshot `max` and this answers for both.
  //
  // Measured on the REPAIRED text, not on `value`: a NUL that was deleted is not content anybody
  // lost, and counting it would put `…[truncated]` on a row that is whole. And not on the SCRUBBED
  // text either — redaction shrinks a string, so a row that dropped everything past the window
  // would then look complete.
  return repaired.length > max
    ? `${clipText(scanned, max)}${TRUNCATED}`
    : scanned;
}

// Scrubs concrete secret-shaped substrings from a string (the VALUE layer). Idempotent.
//
// Deliberately NOT exported: one pattern is anchored to the end of its input, so what this is
// handed has to be a window someone chose on purpose. `scrubbedClip` is that someone, and it is
// also the only order of repair/scrub/cut that does not leak.
function redactSecretsInText(input: string): string {
  let out = input;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

// Recursively copies a value with secrets removed: credential-named keys dropped, secret-shaped
// strings scrubbed, strings truncated, arrays/objects bounded. Non-JSON primitives (functions,
// symbols, bigint) collapse to null/string so the result is always JSON-serializable.
//
// `maxString` is the caller's SIZE policy (see the flowlog's `FlowContext.fullDetail`), default 2000.
// `budget` bounds the ROW, which a per-string cap does not (object key counts are unbounded here):
// strings spend it as the walk proceeds. Opt-in, because sharing 2000 across every string of an event
// would shorten what existing callers write.

// The placeholder a credential-named key gets, CHARGED like any other value: an object's key count
// is unbounded here, so a thousand `password`-ish fields would otherwise write a thousand placeholders
// past an exhausted budget. Emitted whole rather than cut, because half of `‹redacted›` says nothing.
function redactedLeaf(budget?: { left: number }): string {
  if (!budget) return REDACTED;
  if (budget.left <= 0) return "";
  budget.left -= REDACTED.length;
  return REDACTED;
}

export function redactSecretsDeep(
  value: unknown,
  depth = 0,
  maxString = MAX_STRING,
  budget?: { left: number },
): unknown {
  if (depth > MAX_DEPTH) return "‹…›";
  if (value == null) return null;
  if (typeof value === "string") {
    // BOTH bounds apply, and the smaller wins. The budget alone would leave `maxString` dead
    // whenever one is passed, so a caller could raise the per-string ceiling and never notice the
    // ceiling stopped being consulted; `maxString` alone bounds no row. Repair, scrub and cut live
    // in `scrubbedClip` — this decides the LENGTH, that decides the order.
    const allowed = Math.min(maxString, budget ? budget.left : maxString);
    // NOTE: past exhaustion the leaf goes out EMPTY, marker and all, and this is the ONE place that
    // says so. `truncate` would emit `…[truncated]` BY ITSELF for every later field (keys are
    // unbounded), defeating the row bound; the marker on the string that spent the budget already
    // shows where the row was cut.
    if (budget && allowed <= 0) return "";
    const out = scrubbedClip(value, allowed);
    // NOTE: what is CHARGED is what is WRITTEN (the marker, a `‹redacted›` shorter than its token),
    // subtracted rather than assigned so a `maxString` below the remaining budget cannot shrink it.
    if (budget) budget.left -= out.length;
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((v) => redactSecretsDeep(v, depth + 1, maxString, budget));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // NOTE: The KEY gets the same repair as the values. A key is written by whoever produced the
      // object (a model's tool-call arguments, a third party's JSON response), and one orphan half
      // anywhere in the document is enough for Postgres to refuse the whole `jsonb` write.
      //
      // NOTE: The credential rule reads the REPAIRED key, for the same reason the value is repaired
      // before it is scrubbed: `pass<NUL>word` does not match, and the repair then stores it as
      // `password` with its value intact. Testing the stored name is what closes that.
      const key = makeStorable(k);
      // NOTE: `defineProperty`, not assignment: `JSON.parse` yields `__proto__` as an ordinary own
      // property, and assigning to that key invokes the legacy prototype setter instead. The
      // serialization that reaches the column enumerates inherited properties, so the contents of
      // `__proto__` would be written as top-level fields of the log record.
      Object.defineProperty(out, key, {
        value: SECRET_KEY_RE.test(key)
          ? redactedLeaf(budget)
          : redactSecretsDeep(v, depth + 1, maxString, budget),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return out;
  }
  return null;
}

// A short, safe one-line string for an error surfaced to the operator (conversation lastError):
// the message only, secret-scrubbed and length-bounded, never a stack trace or raw provider body.
//
// Also the ONE place error text is made storable, since every error-message column is written through
// here: a `text` column refuses a NUL, and a refused `failJob` write is a job that stops moving.
// tests/lib/storable-write-sweep.test.ts is the ledger of these columns. The order is the one
// `scrubbedClip` documents: repair, scrub, cut.
export function sanitizeErrorMessage(err: unknown, max = 500): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Scanned WHOLE, not to the cut plus a margin, and this surface is the one that can afford it: it
  // already walks the string end to end to flatten its whitespace, so a bounded scan buys nothing
  // here. What it would cost is the WORDS. A long token crossing the window is recognised by its
  // head and collapses to a placeholder — which frees room, but only for text the scan reached, so
  // everything past the window is gone. `Google refused: <600-char JWT> (401)` keeps the `(401)`
  // scanned whole, and loses it scanned to a window, and the `(401)` is the entire message.
  const flat = raw.replace(/\s+/g, " ").trim();
  return scrubbedClip(flat, max, flat.length);
}
