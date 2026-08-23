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

// Every unpaired surrogate replaced with U+FFFD. Cutting is only ONE of the two ways a value gets
// one: any JSON source that spells it out (`"\ud800"`) hands `JSON.parse` an orphan directly, which
// is an ordinary thing for an HTTP tool's response body to do, with no truncation involved at all.
export function replaceLoneSurrogates(value: string): string {
  return ANY_SURROGATE_RE.test(value)
    ? value.replace(LONE_SURROGATE_RE, "�")
    : value;
}
