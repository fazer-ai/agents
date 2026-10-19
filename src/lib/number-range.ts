// The range a configurable number may take, declared once and read by three places: the write schema
// refuses outside it, the runtime reader clamps to it (only a value stored before the schema refused
// it can still be outside), and the console's number field shows it and holds Save. `int` is for
// counts and whole units, where 2.5 is not a value.
export interface NumberRange {
  min: number;
  max: number;
  int: boolean;
}

export const intRange = (min: number, max: number): NumberRange => ({
  min,
  max,
  int: true,
});

export const numberRange = (min: number, max: number): NumberRange => ({
  min,
  max,
  int: false,
});

// A Chatwoot id is an int4 there; one of our row ids is a bigint, sent as a safe JSON integer.
export const CHATWOOT_ID_RANGE = intRange(1, 2_147_483_647);
export const ROW_ID_RANGE = intRange(1, Number.MAX_SAFE_INTEGER);
// A day of the week, 0 (Sunday) through 6 (Saturday).
export const WEEKDAY_RANGE = intRange(0, 6);
// What an HTTP response can carry as its status.
export const HTTP_STATUS_RANGE = intRange(100, 599);

export function inRange(value: number, range: NumberRange): boolean {
  return (
    Number.isFinite(value) &&
    (!range.int || Number.isInteger(value)) &&
    value >= range.min &&
    value <= range.max
  );
}

// The reader's half: a stored value outside the range is pulled to its nearest edge, rounded first
// when the range counts whole units; anything that is not a finite number reads as `fallback`.
export function clampToRange(
  value: unknown,
  range: NumberRange,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = range.int ? Math.round(value) : value;
  return Math.min(Math.max(n, range.min), range.max);
}
