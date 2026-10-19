import { t } from "elysia";
import type { NumberRange } from "@/lib/number-range";

// A REST body number with its range declared: refused with a 422 naming the field, and
// published in the OpenAPI document. tests/modules/number-ranges.test.ts fails on one declared without.
export function tRanged(
  range: NumberRange,
  opts: { description?: string } = {},
) {
  const bounds = { minimum: range.min, maximum: range.max, ...opts };
  return range.int ? t.Integer(bounds) : t.Number(bounds);
}
