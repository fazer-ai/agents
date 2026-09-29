import { describe, expect, test } from "bun:test";

// Every delete of an observer row takes the inbox lock first (the module's order is account, then
// inbox). Deleting an `inbox_observers` row locks it and then its AFTER DELETE trigger updates the
// inbox's `binding_generation`, while `bindInbox` and `unobserveInbox` lock the inbox and then
// delete the row. Opposite orders are a cycle Postgres breaks with 40P01, which the compensation
// path swallows, leaving a pending row while the observer is detached upstream. Asked of the SOURCE
// rather than of two live transactions: staging the interleaving would be a flaky test for a rule
// stated in one line, and this checks every delete, including the next one.

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
