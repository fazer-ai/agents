import { describe, expect, test } from "bun:test";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// The helper IS the guard, so it gets the same treatment every sweep in this suite gets: proven
// against a fixture in both directions before it is pointed at live data. A pin that only ever ran
// against ledgers already at their pinned size would pass whether or not it compared anything.
describe("a waiver ledger is pinned to its size", () => {
  test("an array at its pin passes, and one entry either way fails", () => {
    expect(() => expectWaiverLedger("L", ["a", "b"], 2)).not.toThrow();
    expect(() => expectWaiverLedger("L", ["a", "b", "c"], 2)).toThrow();
    expect(() => expectWaiverLedger("L", ["a"], 2)).toThrow();
  });

  test("a record is measured by its keys, not by its values", () => {
    expect(() =>
      expectWaiverLedger("L", { a: "reason", b: "reason" }, 2),
    ).not.toThrow();
    expect(() => expectWaiverLedger("L", { a: "reason" }, 2)).toThrow();
  });

  // The strongest pin in the set, and the one most likely to be written by accident as `>= 0`: a
  // ledger that is empty on purpose has to refuse its FIRST entry, not its second.
  test("an empty ledger refuses its first entry", () => {
    expect(() => expectWaiverLedger("L", [], 0)).not.toThrow();
    expect(() => expectWaiverLedger("L", {}, 0)).not.toThrow();
    expect(() => expectWaiverLedger("L", ["first"], 0)).toThrow();
    expect(() => expectWaiverLedger("L", { first: "why" }, 0)).toThrow();
  });

  // A Set reaches `Object.keys` as an empty array, so a ledger written as one would report size 0
  // and pass every pin above zero without comparing anything.
  test("a Set is measured by its size, not by its enumerable keys", () => {
    expect(() => expectWaiverLedger("L", new Set(["a", "b"]), 2)).not.toThrow();
    expect(() => expectWaiverLedger("L", new Set(["a"]), 2)).toThrow();
    expect(() => expectWaiverLedger("L", new Set(["a"]), 0)).toThrow();
  });

  test("the failure names the ledger and says which way to fix it", () => {
    expect(() => expectWaiverLedger("SOME_LEDGER", ["a"], 0)).toThrow(
      /SOME_LEDGER is pinned at 0\. A waiver ledger may only shrink/,
    );
  });
});
