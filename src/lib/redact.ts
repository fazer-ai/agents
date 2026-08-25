import { clipText, makeStorable } from "@/lib/text";

// Non-throwing secret redaction for human-facing debug surfaces (the agent playground trace and
// the conversation `lastError` shown to the operator). This is the REPLACE-and-continue cousin of
// n8n-export's `assertNoSecrets`, which THROWS as an export backstop; here we must never break the
// surface, only scrub it. Two layers, same spirit as the export scanner:
//   1. a KEY-name layer — values under credential-named keys are dropped wholesale;
//   2. a VALUE layer — any concrete secret-shaped substring is scrubbed in place.
// By construction the playground trace can never carry a RESOLVED credential (those flow only into
// request headers at fetch time, never into a message), so this is defense-in-depth, not the only
// barrier.

const REDACTED = "‹redacted›";

// High-confidence secret VALUE shapes (global flags: scrub every occurrence, not just the first).
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /(?:bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, // Authorization header material
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style keys
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
  // A JWT HEAD THAT RUNS TO THE END OF WHAT IS BEING SCANNED.
  //
  // Every other shape here is a prefix plus a RUN, so a long enough piece of one still matches and
  // a wide enough scan window is all it takes to recognise a token the cut is about to split. A JWT
  // is not: its match requires two separators and a final segment, and a real payload puts them
  // hundreds of characters in. What is missing from a cut JWT is not length, it is STRUCTURE, so no
  // margin can fix it — the token has to be recognised by its head.
  //
  // Anchored at the end because that is where a cut leaves it, and because anchoring is what keeps
  // this from redacting every base64 blob that happens to start with `eyJ` in the middle of a
  // sentence. The one above still handles a complete token and runs first.
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

// HOW MUCH SOURCE TO TAKE so the repaired window is `need` characters long.
//
// The repair happens INSIDE the window, and one half of it DELETES: `makeStorable` drops every NUL
// and replaces a lone surrogate one for one. So a source window of `need` characters comes back
// shorter by however many NULs it held, and the margin that is supposed to sit past the cut is
// spent on characters that no longer exist. Sixty-four NULs are enough to spend all of it, and the
// cut-before-scrub leak comes straight back: measured, `sk-` plus fifteen of a sixteen-character
// token, stored raw, from a value a webhook can send.
//
// Counted rather than estimated, because the count is exactly the number of NULs and nothing else
// shrinks. The walk stops as soon as it has enough, so it costs `need` plus whatever NULs sit in
// front of it, and an input that is all NULs costs one pass and stores nothing anyway.
function sourceFor(value: string, need: number): number {
  let end = 0;
  let kept = 0;
  while (kept < need && end < value.length) {
    if (value.charCodeAt(end) !== 0) kept++;
    end++;
  }
  return end;
}

// REPAIR, SCRUB, THEN CUT — the one order, in the one place, because every surface that stores a
// third party's text needs all three and two of the three orders leak.
//
// The cut cannot come first. A cut landing inside a credential leaves a prefix, and a prefix
// shorter than its pattern's minimum no longer matches: eighteen characters of room turn `sk-` plus
// a sixteen-character token into fifteen characters of that token, stored raw, in a row an operator
// reads. Measured, and it is why this function exists.
//
// The repair cannot come second. `makeStorable` DELETES a NUL rather than replacing it, so a token
// the pattern missed only because a NUL sat inside it (`sk-<NUL>abcd…`) would be handed back whole
// by a repair that ran after the scrub (issue #241 review).
//
// And the scan still does not read the whole input, because the cut is the cheap bound and a 10 MB
// tool result is not scanned six times to store two thousand characters of it. It reads the cut
// plus `SECRET_SCAN_MARGIN`, which is what makes "cut last" affordable.
//
// The marker is decided by the INPUT's length, not the scrubbed one: a redaction shrinks the text,
// and content past the margin was still dropped.
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
// `maxString` is a parameter rather than the constant it was because the ceiling on a stored string
// is a SIZE policy, and the caller is the only one that knows which policy applies to this write —
// see the flowlog's debug mode (`FlowContext.fullDetail`). It is never absent: the default is the
// same 2000 every caller had before.
//
// `budget` is the OTHER half of that, and it is opt-in because a per-string cap bounds no ROW.
// `detail` is a tree, an object's key count is not bounded here (only arrays and depth are), and
// fifty leaves under a 300k allowance is a 15 MB row. A caller that raises the ceiling therefore
// passes a budget too: the number is spent as the walk proceeds, the first string may take all of
// it, and the next one gets what is left. On the line the debug mode exists for this changes
// nothing — a `generate` line's detail holds exactly one string — and on a tool line with the
// values switch also on it is the difference between bounded and not.
//
// It is opt-in rather than the default because sharing the ordinary 2,000 across every string of an
// event would silently shorten what every existing caller already writes. Absent, each string is
// capped on its own, exactly as before.

// The placeholder a credential-named key gets, CHARGED like any other value. It is bytes in the
// column exactly as a string is, and an object's key count is not bounded here — so a tool result
// with a thousand `password`-ish fields would write a thousand placeholders past an exhausted
// budget, which is the truncation marker's leak arriving through the key layer instead of the value
// layer. Emitted whole rather than cut, because half of `‹redacted›` says nothing; the overshoot is
// one placeholder, not one per field.
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
    // Past exhaustion the leaf goes out EMPTY, marker and all, and this is the ONE place that says
    // so — a spent budget goes negative, and every guard downstream of it was a second spelling of
    // this same check.
    //
    // `truncate(s, max)` appends its marker whenever `s.length > max`, so with nothing left to
    // spend it emits the marker BY ITSELF, for an empty string as readily as for a long one. An
    // object's key count is not bounded here, so one long string that spends the budget followed by
    // a thousand short fields would write a thousand `…[truncated]`s: the whole-row bound the
    // budget exists to be, gone by however many fields the tree happens to have. The marker on the
    // string that spent the budget is what tells a reader where the row was cut; the empty leaves
    // after it say the same thing by being empty.
    if (budget && allowed <= 0) return "";
    const out = scrubbedClip(value, allowed);
    // What is CHARGED is what is WRITTEN, not what came in. The marker is bytes in the column and so
    // is a `‹redacted›` that replaced a longer token, so charging the input both overshot the row by
    // one marker per cut string and spent the budget on tokens that never reached the column. It
    // also stops `maxString` from being able to SHRINK the budget: the old arithmetic ASSIGNED
    // `allowed - n`, so a per-string ceiling below the remaining budget threw the rest of it away.
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
// Also the ONE place the storability rule is applied to error text, because every column that holds
// an error message is written through here. A `text` column refuses a NUL outright, and a lone
// surrogate costs a character off the tail before it either lands corrupted or refuses. What the
// refusal costs is not the string: `failJob`'s write IS the transition that schedules the retry or
// dead-letters the job, so refused, the row stops moving. tests/lib/storable-write-sweep.test.ts is
// the ledger of these columns, and carries how a third party's bytes reach one (issue #243).
//
// `makeStorable` runs BEFORE the scrub, never after. It DELETES the NUL rather than replacing it,
// so a token the pattern missed only because a NUL sat inside it (`sk-<NUL>abcd…`) would be handed
// back whole by a repair that ran second (issue #241 review). The cut stays last: it cannot
// manufacture an orphan half for the repair to have to catch, and repairing first is what makes
// the length it measures the length that gets stored.
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
