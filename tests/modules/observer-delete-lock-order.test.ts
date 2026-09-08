import { describe, expect, test } from "bun:test";

// EVERY DELETE OF AN OBSERVER ROW TAKES THE INBOX LOCK FIRST (issue #540, PR review round 5).
//
// The rule is old — this module has one lock order, account then inbox — and what made it load
// bearing is the trigger that now steps `binding_generation`. Deleting an `inbox_observers` row
// locks that row and then, inside the same statement, the AFTER DELETE trigger updates the inbox;
// `bindInbox` and `unobserveInbox` lock the inbox first and then wait to delete the same row. Two
// transactions doing those in opposite orders is a cycle, and Postgres resolves it by aborting one
// with 40P01 — which on the compensation path is caught and swallowed, leaving a pending row behind
// while the observer is detached upstream. The two sides then disagree, which is the single thing
// this whole path is built to avoid.
//
// Asked of the SOURCE rather than of a running pair of transactions, and deliberately: staging the
// interleaving takes two connections and precise sequencing, and the result would be a flaky test
// for a rule a reader can state in one line. What is checked is that rule, on every delete, so the
// next one written cannot quietly leave the lock out.

const SRC = "src/modules/chatwoot/management.ts";
const src = await Bun.file(SRC).text();

// The lock, as every site in this module spells it — `bindInbox` takes it through a reading that
// selects a column with it, and the rest as a bare `SELECT id`, so the tail is what they share.
const LOCK = /FROM inboxes\s+WHERE id = \$\{inboxId\}\s+FOR NO KEY UPDATE/;

describe("the observer row is never deleted without the inbox lock", () => {
  test("every inboxObserver delete has the lock earlier in its own transaction", () => {
    const deletes = [
      ...src.matchAll(/db\.inboxObserver\.delete(?:Many)?\(/g),
    ].map((m) => m.index ?? 0);
    // Four today: the retire inside `bindInbox`, `unobserveInbox`, and the two in `observeInbox`
    // (the compensation and the `responderWon` branch). A new site needs the same reading.
    expect(deletes.length).toBeGreaterThanOrEqual(4);
    const missing: string[] = [];
    for (const at of deletes) {
      const opened = src.lastIndexOf("runScopedOn(", at);
      expect(opened).toBeGreaterThan(-1);
      const body = src.slice(opened, at);
      if (!LOCK.test(body)) {
        // Named by the line, which is what a reader needs to go and look.
        missing.push(String(src.slice(0, at).split("\n").length));
      }
    }
    expect(missing).toEqual([]);
  });
});
