import { expect } from "bun:test";

// A sweep that subtracts a hand-written ledger of known offenders is guarded in ONE direction by
// construction, and every file that holds one tests that direction: the offender set is derived from
// the tree, so an entry that stopped offending shows up as a waiver nobody removed.
//
// The other direction has no anchor in the tree at all. Appending one name silences a NEW offender
// AND satisfies the stale-waiver rule, so the suite goes green. Measured on
// `SAY_LESS_GRANDFATHERED`, against main: a fresh throw site whose message interpolates, on
// `errors.agentNotFound`, whose catalog entry carries no placeholder, took
// tests/api/error-catalog.test.ts from `1 fail` to `0 fail` by that append alone (issue #293).
//
// The SIZE is the only fact about a ledger the tree cannot supply, which is what makes it the anchor.
// Pinning it does not make growth impossible in a file its author owns, and is not meant to: it makes
// growth a SECOND edit, in a different place, that reads as a sentence in the diff. `- 26` / `+ 27`
// says the backlog got worse; an appended string says nothing.
//
// EXACT, never an upper bound. A bound sitting above the truth is slack, and slack is one free append
// per unit of it: a ledger worked from 26 down to 20 under `toBeLessThanOrEqual(26)` has six silent
// appends banked. Exact equality makes working a ledger DOWN cost the same second edit that growing
// it does, which is the trade this accepts.
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
