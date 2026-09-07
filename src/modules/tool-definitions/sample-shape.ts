// WHAT WE MAY KEEP OF A SAMPLE RESPONSE, so the tool editor's pickers survive a reopen without the
// customer's data surviving with them (issue #566).
//
// The sample an operator pastes is a real response from a real API. It routinely carries names,
// e-mail addresses, phone numbers, CPF, prices and internal ids, and sometimes a token echoed back
// in the body. Storing it would put a third party's personal data in a column nobody thinks of as
// data storage, and from there into every backup.
//
// THE SPLIT THIS MODULE EXISTS FOR. The screen has two consumers of the sample and they need
// different things: the pickers and the caret completion need PATHS, and only the preview needs
// VALUES. So the paths are what gets stored — the keys, with every value replaced by a stand-in —
// and the response itself never leaves the browser that received it. "We never store it" is a
// stronger invariant than "we store it when a toggle is on": there is no backup question, no bundle
// question, and no export rule to keep in step.
//
// AND THE SERVER REDACTS AGAIN ON WRITE. The client redacts so the response does not travel over the
// wire; the server redacts so the invariant is a property of the STORAGE and not of whichever client
// happened to send the row. The two are not redundant, they answer different questions.
//
// WHY A STRING KEEPS ITS LENGTH. Not decoration. The per-value clip and the model's overall limit
// are exactly what `response-template.ts` exists to prevent (#456: a truncated payload does not read
// to a model as missing data, it reads as a gap to fill from training data). A preview over a fixed
// `"string"` would show a template fitting comfortably where the real values overflow and drop the
// fields after them — the operator would be checking a promise the runtime does not keep. Length is
// the one property that makes the preview exact about SIZE while storing none of the content.

import { MAX_VALUE_CHARS } from "@/modules/tool-definitions/response-template";

// The stand-in for one character. ASCII on purpose: the renderer's own cut is `clipText`, which
// spends a unit dropping an orphan surrogate half, and a stand-in that could contain one would make
// the preview shorter than the response it stands for — the single thing this redaction promises to
// get right. Also the shape that reads as "redacted" to anyone who opens the row.
const STAND_IN_CHAR = "x";

// A stand-in never needs to be longer than the point where the renderer stops caring. Past
// `MAX_VALUE_CHARS` the renderer clips and appends its marker whatever the true length was, so a
// value 50k long and one 2002 long render identically — and storing the difference would make the
// shape as large as the response it replaces, for nothing.
const MAX_STAND_IN_CHARS = MAX_VALUE_CHARS + 1;

// The smallest integer both readers refuse: `renderScalar` and the appointment's reader answer
// `undefined` past `Number.MAX_SAFE_INTEGER`, and this is one past it. Exactly representable as a
// double, so the literal is not itself a rounded lie.
const REFUSED_NUMBER = Number.MAX_SAFE_INTEGER + 1;

// Past this the shape is not stored at all, rather than stored truncated. Truncating would drop
// keys, and a picker that silently stops offering half a response is worse than one that offers
// nothing: the operator reads the gap as "that field is not in the response" and fixes a template
// that was right. The number is generous next to any response a person pastes to design against.
export const SAMPLE_SHAPE_MAX_CHARS = 64_000;

export interface StoredSampleShape {
  // The status the sample came back under, or null when it was pasted by hand. It travels WITH the
  // shape because the preview branches on it: a sample captured from a 404 the tool declares a
  // "no result" status is projected differently, and a shape stored without it would reopen reading
  // that 404 as a 200.
  status: number | null;
  body: unknown;
}

// A KEY IS DATA UNLESS IT LOOKS LIKE A SCHEMA (round 1 of review, P1). Redacting values alone does
// not keep this module's promise: an API that answers `{"users": {"ana@example.com": {…}}}` or a map
// keyed by CPF would have copied a person's identifier into the column verbatim, and from there into
// every backup — under a header claiming the opposite.
//
// The rule is the one the OFFER already implies rather than a guess about intent. A path segment has
// to match `isUsablePath`'s grammar to be offered at all, and a key that begins with a digit is not
// a field name any operator writes a template against: it is an entry in a map, and a path through a
// map is worthless to them anyway, because it resolves for exactly one customer. So a key outside
// this pattern takes its whole subtree with it — dropped, not redacted, because a redacted KEY is a
// path that resolves against nothing and the picker would offer it.
//
// It also closes what would otherwise be a save that fails at the database: a JSON key decoded from
// `"\u0000"` or holding a lone surrogate is refused by Postgres inside a jsonb write, and values
// cannot carry one (every stand-in here is ASCII) but keys were passing through untouched.
const SCHEMA_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

// Same rendered length, and never accepted where the real number is refused. Both halves are
// load-bearing, and the second is the one that is not obvious: `renderScalar` refuses a number past
// `Number.MAX_SAFE_INTEGER` (past 2^53 `JSON.parse` has already lost the digits, so showing the
// model an id nobody issued is worse than showing nothing), so a 16-digit id the real response does
// NOT offer came back as `0`, which every reader accepts — and the picker offered a path that
// resolves to nothing against the real thing (round 1 of review).
//
// It also has to be IDEMPOTENT, because the fingerprint below compares a shape this ran on once
// against the one the service stored after running it again. All nines of the same width is not, on
// its own: `9.99999999999999999` re-parses to `10`, and a 16-nine integer to `1e16`.
function standInNumber(n: number): number {
  // Refused, and refused again on its own output: a number the readers will not render must not
  // become one they will. Width is not kept here because a refused value is never rendered — but the
  // SENTINEL's own width is, and it is the smallest refused integer rather than something like
  // `1e308` for a reason measured in the column: jsonb normalises the numeric literal, so `1e308`
  // came back as three hundred and nine digits, and the size cap is counted on `JSON.stringify`
  // before the write, where it is six characters.
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
    return REFUSED_NUMBER;
  const wide = Number(String(n).replace(/[0-9]/g, "9"));
  // Stable only when the re-parse did not round. When it did, one digit — accepted, like the
  // original, and a fixed point of this function.
  return String(wide).replace(/[0-9]/g, "9") === String(wide) ? wide : 9;
}

// Structure kept, every value replaced. `null` is not data, so it stays: it is the difference
// between "the API returned nothing here" and "the API did not return this key", and the template
// renders the two the same way for the model but the PICKER must not offer a path that does not
// exist.
export function redactSample(node: unknown): unknown {
  if (typeof node === "string") {
    return STAND_IN_CHAR.repeat(Math.min(node.length, MAX_STAND_IN_CHARS));
  }
  if (typeof node === "number") return standInNumber(node);
  if (typeof node === "boolean") return true;
  if (node === null) return null;
  if (Array.isArray(node)) return node.map(redactSample);
  if (typeof node === "object") {
    // NOTE: a null prototype, so an OWN `__proto__` key survives. `JSON.parse` makes that an
    // ordinary own property and `walkPath` resolves it with `Object.hasOwn`, but assigning it onto
    // `{}` runs the legacy prototype setter instead: the key vanished from the shape and a path that
    // works against the real response was missing after a reopen (round 1 of review).
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(node)) {
      if (!SCHEMA_KEY.test(k)) continue;
      out[k] = redactSample(v);
    }
    // NOTE: spread back to an ordinary object, measured to KEEP the own `__proto__` (spread uses
    // CreateDataProperty, not assignment), so nothing downstream has to reason about a null
    // prototype.
    return { ...out };
  }
  // A body came out of JSON.parse, so nothing else can reach here; a value that somehow did is not
  // something a path may end on either way.
  return null;
}

// The row to store, or null when there is nothing storable. Serialized once, here, because the size
// question is about what lands in the column and not about the tree in memory.
export function storableShape(
  body: unknown,
  status: number | null,
): StoredSampleShape | null {
  const redacted = redactSample(body);
  if (JSON.stringify(redacted).length > SAMPLE_SHAPE_MAX_CHARS) return null;
  return { status, body: redacted };
}

// The wire value, read the way the runtime readers in this folder are read: whatever arrived is
// judged here and comes back either storable or null, never trusted as sent. This is the half that
// makes "no response is stored" a property of the COLUMN — the client redacts so the response does
// not travel, and this redacts again so a client that skipped that step still cannot write one.
export function readStorableShape(raw: unknown): StoredSampleShape | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const o = raw as Record<string, unknown>;
  if (!("body" in o)) return null;
  const status = o.status;
  return storableShape(
    o.body,
    typeof status === "number" && Number.isInteger(status) ? status : null,
  );
}

// A shape's identity, order-insensitively, so the two halves of a stored sample can be told apart
// from each other (round 1 of review). The browser's copy of the response is only the right one
// while the ROW still holds the shape it produced: another machine (or the API) saving a newer
// sample leaves this one restoring stale values, and its next save would derive a shape from them
// and overwrite the newer one.
//
// Sorted keys because the two sides are not serialized by the same thing. Ours comes straight out of
// `redactSample`; the server's has been through a jsonb column, which stores an object with its keys
// REORDERED (by length, then bytes) — measured on the row this feature writes: `{"nome","cpf"}` came
// back `{"cpf","nome"}`. A plain `JSON.stringify` comparison would call every restored sample stale.
export function fingerprintShape(shape: StoredSampleShape | null): string {
  const canon = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(canon);
    if (n !== null && typeof n === "object") {
      return Object.fromEntries(
        Object.entries(n)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canon(v)]),
      );
    }
    return n;
  };
  return shape === null ? "" : JSON.stringify(canon(shape));
}
