import { AppError } from "@/lib/errors";

// A caller-supplied string as a database id, or nothing.
//
// `BigInt` alone is too lenient: it accepts spellings a column does not (`0x7`, `+7`, ` 7 `, `1e3`)
// and values past 2^63-1, which Postgres then refuses at bind time as a 500 on a path that meant to
// answer "no such row". A digits-only regex covers only the first half; the range is the second.
// What the caller DOES with `null` is still theirs: a 400, a null row, or a fallback.
export const MAX_DB_ID = 9223372036854775807n;

const DIGITS = /^\d+$/;

export function parseDbId(raw: string | null | undefined): bigint | null {
  if (!raw || !DIGITS.test(raw)) return null;
  const id = BigInt(raw);
  return id > MAX_DB_ID ? null : id;
}

// The same parse for a caller whose only answer to a bad id is to refuse: a route handler, where
// `null` has nowhere to go. Kept beside the parse so the two cannot drift, and so a route reaches
// for this instead of writing `BigInt(params.id)` — which is the spelling that skips the range and
// turns a malformed field into a 500 raised by Postgres when the query binds it.
export function requireDbId(
  raw: string | null | undefined,
  label = "id",
): bigint {
  const id = parseDbId(raw);
  if (id === null) {
    throw new AppError(`invalid ${label}`, 400, "errors.invalidId", {
      label,
    });
  }
  return id;
}

// The same parse for an id a request BODY carries, where an absent key leaves the column as it is
// and an explicit `null` detaches it; collapsing the two makes a PATCH that clears a reference keep it.
// An empty string is refused, since `BigInt("")` is `0n` and would address row zero.
//
// `label` is the name the BODY uses for the field ("Not a valid businessHoursId"), not a noun phrase:
// the caller is looking at a key they wrote. Path segments keep the noun-phrase form.
export function optionalDbId(
  raw: string | null | undefined,
  label = "id",
): bigint | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return requireDbId(raw, label);
}
