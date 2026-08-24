// The two halves of one problem: a JS string is a sequence of UTF-16 code UNITS, not of characters.
// An astral character (an emoji, a letter outside the BMP, a CJK extension ideograph) is stored as a
// SURROGATE PAIR, and either half alone is not a character at all.
//
// Postgres says so out loud: a `jsonb` write carrying an unpaired surrogate is refused outright
// (`22P02`, "Unicode low surrogate must follow a high surrogate"). `execution_logs.detail` is such a
// column and `emitFlowEvent` is fire-and-forget with a catch, so the refusal never reaches the turn —
// the stage line the operator later goes looking for simply is not there. Where one does survive a
// write it renders as a replacement character in the middle of somebody's name or address.

// Cut to `max` UTF-16 units without ever ending on half of a character. Dropping the orphan half
// costs one character off a value that was too long anyway.
//
// This is the cut EVERY length cap uses; `tests/lib/astral-cap-sweep.test.ts` is the list of them. An
// index-based slice at a position the code computed (a delimiter, a trailing separator, an array
// bound) is a different operation and not what this replaces.
export function clipText(value: string, max: number): string {
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// The mirror of `clipText`, for a cap that keeps the END of a value: a start index that lands
// between two halves leaves the result BEGINNING with an orphan low surrogate. Same cost, same
// remedy, and it exists as its own function because the two are not interchangeable — a caller that
// keeps the tail is answering a different question ("what is the most recent 60k characters") and
// would silently keep the wrong end if handed the other one.
export function clipTextEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(value.length - max);
  const first = cut.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut;
}

// How much room above a cap an OVERFLOW PROBE needs. A caller that bounds a value at `cap + 1` and
// then tests `length > cap` is asking one number two questions, and `clipText` can spend that single
// spare unit dropping an orphan half: the value comes back exactly `cap` long, reads as "nothing was
// cut", and loses the ellipsis that keeps a partial fact from reaching the model as a complete one
// ("Rua X, 12" for "Rua X, 1234"). Two units cannot both be spent that way, because a cut drops at
// most one.
export const OVERFLOW_PROBE_MARGIN = 2;

// A high surrogate with no low surrogate after it, or a low surrogate with no high surrogate before
// it. The lookaround is what spares a well-formed pair.
const LONE_SURROGATE_RE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// Most strings hold no surrogate at all, and this runs on every string of every execution-log detail.
const ANY_SURROGATE_RE = /[\ud800-\udfff]/;
// The other character a `text` or `jsonb` column refuses. Spelled as a code unit: a literal NUL in
// a source file is invisible in every diff and every review.
const NUL = "\u0000";

// Every unpaired surrogate replaced with U+FFFD. Cutting is only ONE of the two ways a value gets
// one: any JSON source that spells it out (`"\ud800"`) hands `JSON.parse` an orphan directly, which
// is an ordinary thing for an HTTP tool's response body to do, with no truncation involved at all.
export function replaceLoneSurrogates(value: string): string {
  return ANY_SURROGATE_RE.test(value)
    ? value.replace(LONE_SURROGATE_RE, "�")
    : value;
}

// The REPAIR half of the rule `unstorableProblem` REPORTS: same two characters, opposite policy.
// Refusing is right where the author reads the refusal and can go fix the value (an operator's
// form). Repairing is right where the writer is a third party's webhook, which never reads a
// refusal and whose only recourse is to retry the identical bytes until its budget runs out. There
// a refusal costs the event, and the repair keeps it.
//
// The two are not repaired the same way, because they do not mean the same thing. An unpaired
// surrogate WAS half of a real character, so U+FFFD stands where that character was. A NUL never
// stood for anything a reader would see, and is simply dropped.
//
// The ORDER carries a rule of its own: surrogates are repaired while the NULs are still in place.
// Dropping the NUL out of `\ud800 \udc00` first would leave the two orphan halves adjacent, and
// they would then read as the well-formed pair U+10000 and survive untouched, inventing a character
// nobody wrote out of three defects. Repairing first keeps each defect represented by its own
// U+FFFD.
export function makeStorable(value: string): string {
  const repaired = replaceLoneSurrogates(value);
  return repaired.includes(NUL) ? repaired.replaceAll(NUL, "") : repaired;
}

// A deeper document than any allowlisted projection has, which is the only shape this is called on.
const MAX_STORABLE_DEPTH = 8;

// `makeStorable` over a whole JSON document, KEYS included: one orphan half anywhere in it is enough
// for Postgres to refuse the entire `jsonb` write, so the unit that has to come back storable is the
// document, not the field. Reaching every string structurally is also what keeps a field added to
// the shape later from arriving unrepaired.
//
// Values that are not part of a JSON document (a `Date`, a class instance) are returned as they are:
// they carry no string for the write to choke on, and rebuilding them from their entries would
// destroy them. Below the depth cap the branch is DROPPED rather than passed through: something
// nested that deep is not the bounded projection this is for, and losing one branch of it beats
// losing the whole event to a refused INSERT.
export function makeStorableDeep<T>(value: T, depth = 0): T {
  if (typeof value === "string") return makeStorable(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_STORABLE_DEPTH) return null as T;
  if (Array.isArray(value)) {
    return value.map((v) => makeStorableDeep(v, depth + 1)) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // `defineProperty`, not assignment: `JSON.parse` gives `__proto__` as an ORDINARY own property
    // (a key a third party's body can carry, and one a malformed key can repair INTO), while
    // assignment on that same key invokes the legacy prototype setter instead. The field would
    // vanish from what gets persisted and the copy would come back with a different prototype.
    Object.defineProperty(out, makeStorable(k), {
      value: makeStorableDeep(v, depth + 1),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out as T;
}

// What PostgreSQL refuses to STORE, which is a different question from what anything can draw.
//
// Two characters, one reason each. A NUL is not representable in `text` or in `jsonb`. An unpaired
// surrogate is refused by a `jsonb` write outright (`22P02`, the same refusal `clipText` exists to
// avoid producing). Neither needs truncation to arrive: any JSON body that spells one out
// (`"\u0000"`, `"\ud800"`) hands `JSON.parse` the character directly, which an HTTP or MCP client can
// send at any time.
//
// The consequence is what makes this worth a check rather than a catch: the value passes every
// bound the API advertises and then fails at the INSERT — a 500 for a REST caller, or, inside a
// transaction wrapping several writes, the loss of all of them. A refusal names what to change.
//
// SEPARATE from the documents module's `unprintableProblem`, and deliberately narrower: a string can
// be perfectly storable and impossible to print (an emoji in a tool description a model reads and
// nobody draws). A caller that only needs the value to survive its column asks this one.
// The offenders themselves, named by code point, or null when the value is storable. Separate from
// the message because a REFUSAL that crosses a localized boundary needs the values, not a sentence:
// interpolating an English sentence into a translated template answers a pt-BR caller in two
// languages at once. The field name stays English on purpose, in both forms: it names the request
// field the caller has to change, the way a schema path does.
export function unstorableCodePoints(value: string): string[] | null {
  // A Set, not a scan of a growing array: the distinct offenders number 2049 (a NUL and every
  // surrogate code unit), so `includes` on the accumulator turns a long malformed value into
  // quadratic work on a caller's behalf. Insertion order is preserved either way, so they are named
  // in the order they appear.
  const bad = new Set<string>();
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // `for...of` yields a well-formed pair as ONE two-unit string, so a single-unit string in the
    // surrogate range never had its other half.
    const lone = ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
    if (code === 0 || lone) bad.add(ch);
  }
  if (bad.size === 0) return null;
  // Named by code point, never pasted: quoting the character itself would put a NUL into a log line
  // and an API response, and half a character into a JSON body.
  return [...bad].map(
    (ch) =>
      `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
}

export function unstorableProblem(value: string, what: string): string | null {
  const named = unstorableCodePoints(value);
  if (named === null) return null;
  return `${what} contains characters the database cannot store (${named.join(" ")}) — a NUL or half of a character, which PostgreSQL refuses in text and JSON columns alike.`;
}

export interface UnstorableField {
  // The request field the caller has to change. English, like a schema path.
  what: string;
  // The offenders, e.g. ["U+0000"].
  codePoints: string[];
  // The same thing as one English sentence, for a caller with nowhere to put the parts: a log line,
  // an MCP error, the untranslated fallback of a localized refusal.
  message: string;
}

// The same question asked of a whole WRITE rather than one value: a row is refused as a unit, so
// checking one field and not its neighbours only moves which value produces the 500. Returns the
// first offender, or null. Undefined and null are skipped, so an optional column can be listed
// unconditionally and a field added to the shape later joins by being listed here.
//
// Pure on purpose, and it returns the PARTS rather than only the sentence, because what a refusal
// looks like is the caller's question. The same unstorable value is a 400 whose text a REST caller
// reads in their own language, and an MCP tool failure a client reads in English.
export function firstUnstorableField(
  fields: readonly (readonly [string, string | null | undefined])[],
): UnstorableField | null {
  for (const [what, value] of fields) {
    if (typeof value !== "string") continue;
    const codePoints = unstorableCodePoints(value);
    if (codePoints) {
      return {
        what,
        codePoints,
        message: unstorableProblem(value, what) as string,
      };
    }
  }
  return null;
}
