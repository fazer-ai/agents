// A caller-supplied string as a database id, or nothing.
//
// `BigInt` is arbitrary precision and lenient, and both halves of that bite. It accepts spellings a
// column does not (`0x7`, `+7`, ` 7 `, `1e3`), and it accepts values no column can hold: an id past
// 2^63-1 parses here and is refused by POSTGRES instead, when the query binds it — a 500 for what is
// plainly a malformed field, and on a path that meant to answer "no such row".
//
// The rule was learned in the vault (requireVaultRef) and then re-derived, badly, everywhere else: a
// digits-only regex is the half people remember, and the range is the half they do not. It lives
// here so the next reader inherits both, and so "is this an id?" has one answer instead of one per
// caller. What the caller DOES with `null` is still theirs: a 400, a null row, or a fallback.
export const MAX_DB_ID = 9223372036854775807n;

const DIGITS = /^\d+$/;

export function parseDbId(raw: string | null | undefined): bigint | null {
  if (!raw || !DIGITS.test(raw)) return null;
  const id = BigInt(raw);
  return id > MAX_DB_ID ? null : id;
}
