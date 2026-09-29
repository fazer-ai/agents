import { expect } from "bun:test";

// A sweep that subtracts a hand-written ledger of known offenders is guarded in ONE direction by
// construction: the offender set is derived from the tree, so an entry that stopped offending shows
// up as a stale waiver. The other direction has no anchor: appending one name silences a NEW
// offender AND satisfies the stale-waiver rule (one append to `SAY_LESS_GRANDFATHERED` turns a real
// failure in tests/api/error-catalog.test.ts green). The SIZE is the one fact the tree cannot supply,
// so it is the anchor: growth becomes a SECOND edit that reads in the diff (`- 26` / `+ 27`). EXACT,
// never an upper bound: slack above the truth is one silent append per unit, and exact equality
// makes working a ledger DOWN cost the same second edit, which is the trade this accepts.
export function expectWaiverLedger(
  name: string,
  ledger:
    | readonly unknown[]
    | ReadonlySet<unknown>
    | Readonly<Record<string, unknown>>,
  pinned: number,
): void {
  // NOTE: a `Set` reaches `Object.keys` as `[]`, so a ledger written as one would report size 0 and
  // pass every pin above zero silently. Two of the thirteen are Sets.
  const size = Array.isArray(ledger)
    ? ledger.length
    : ledger instanceof Set
      ? ledger.size
      : Object.keys(ledger).length;
  expect(
    size,
    `${name} is pinned at ${pinned}. A waiver ledger may only shrink: if the sweep flagged something ` +
      `new, fix it instead of listing it here. If you worked the ledger DOWN, lower the pin to match, ` +
      `so no slack is left over for a future append to spend.`,
  ).toBe(pinned);
}
