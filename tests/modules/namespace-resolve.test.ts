import { describe, expect, test } from "bun:test";
import { resolveByModelName } from "@/modules/tool-definitions/namespace";

// Round 29. `toolsUnderModelName` answers "is this name taken", where every match counts. Choosing
// WHICH tool a grant binds to is a different question, and `[0]` off an unordered read answered it
// by whatever the database listed first. A destination can hold `Foo` and `foo` side by side: the
// old unique index was case-sensitive, so both were legal, and both derive `foo`. Binding the grant
// to the wrong one calls a different endpoint with a different credential, and nothing on screen
// says so.
describe("resolveByModelName", () => {
  const rows = [
    { id: 1n, name: "Foo" },
    { id: 2n, name: "foo" },
    { id: 3n, name: "bar" },
  ];

  test("the exact stored spelling wins, because it is the one answer that is not a guess", () => {
    expect(resolveByModelName(rows, "Foo")).toEqual({ kind: "one", id: 1n });
    expect(resolveByModelName(rows, "foo")).toEqual({ kind: "one", id: 2n });
  });

  test("a single derived match is the case canonicalization exists to serve", () => {
    // `Bar` is nobody's stored spelling; exactly one row derives it.
    expect(resolveByModelName(rows, "Bar")).toEqual({ kind: "one", id: 3n });
  });

  test("two derived matches and no exact one is ambiguous, never a pick", () => {
    expect(resolveByModelName(rows, "FOO")).toEqual({
      kind: "ambiguous",
      ids: [1n, 2n],
    });
  });

  test("a name nothing carries is none", () => {
    expect(resolveByModelName(rows, "nada")).toEqual({ kind: "none" });
  });

  // The order of the rows must not decide anything: the same set read the other way answers the
  // same, which is exactly what `[0]` could not promise.
  test("the answer does not depend on the order the rows arrive in", () => {
    const reversed = [...rows].reverse();
    expect(resolveByModelName(reversed, "Foo")).toEqual({
      kind: "one",
      id: 1n,
    });
    expect(resolveByModelName(reversed, "FOO")).toMatchObject({
      kind: "ambiguous",
    });
  });
});
