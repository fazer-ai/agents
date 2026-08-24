import { describe, expect, test } from "bun:test";
import {
  clipText,
  clipTextEnd,
  makeStorable,
  makeStorableDeep,
  replaceLoneSurrogates,
  unstorableProblem,
} from "@/lib/text";

// An unpaired surrogate is the failure both functions exist to prevent, so every assertion below is
// ultimately this predicate. `for...of` yields a well-formed pair as ONE two-unit string, so a
// single-unit string in the surrogate range is by definition an orphan half.
function loneSurrogates(s: string): number {
  let n = 0;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code >= 0xd800 && code <= 0xdfff) n++;
  }
  return n;
}

describe("clipText", () => {
  // 😀 is U+1F600: two UTF-16 units, so a cut at 4 lands between its halves.
  const cases: [string, string, number, string][] = [
    ["under the cap is untouched", "abc", 10, "abc"],
    ["exactly at the cap is untouched", "abcd", 4, "abcd"],
    ["cuts between characters like slice", "abcdef", 4, "abcd"],
    ["cut BETWEEN the halves drops the orphan", "abc😀def", 4, "abc"],
    ["cut AFTER a whole pair keeps it", "abc😀def", 5, "abc😀"],
    ["cut BEFORE a pair does not touch it", "abc😀def", 3, "abc"],
    ["a cap of zero yields empty", "😀", 0, ""],
    ["an all-astral value can lose its only character", "😀", 1, ""],
    ["empty in, empty out", "", 5, ""],
  ];
  for (const [name, input, max, want] of cases) {
    test(name, () => {
      expect(clipText(input, max)).toBe(want);
    });
  }

  test("no cut position of an astral string ever leaves an orphan half", () => {
    const s = "😀🙂🎉ok😀";
    for (let max = 0; max <= s.length + 2; max++) {
      expect(loneSurrogates(clipText(s, max))).toBe(0);
    }
  });

  test("a LOW surrogate at the end is left alone: it is the cut that makes orphans, not the input", () => {
    // clipText only refuses to END on a high surrogate. An orphan that was already in the input is
    // replaceLoneSurrogates' job — the two do different halves of the same problem.
    const lone = JSON.parse('"ab\\udc00cd"') as string;
    expect(loneSurrogates(clipText(lone, 3))).toBe(1);
  });
});

describe("clipTextEnd", () => {
  const cases: [string, string, number, string][] = [
    ["under the cap is untouched", "abc", 10, "abc"],
    ["exactly at the cap is untouched", "abcd", 4, "abcd"],
    ["keeps the END, not the start", "abcdef", 4, "cdef"],
    ["a start BETWEEN the halves drops the orphan", "abc😀def", 4, "def"],
    ["a start ON a whole pair keeps it", "abc😀def", 5, "😀def"],
    ["a cap of zero yields empty", "😀", 0, ""],
    ["an all-astral value can lose its only character", "😀", 1, ""],
  ];
  for (const [name, input, max, want] of cases) {
    test(name, () => {
      expect(clipTextEnd(input, max)).toBe(want);
    });
  }

  test("no start position of an astral string ever leaves an orphan half", () => {
    const s = "😀🙂🎉ok😀";
    for (let max = 0; max <= s.length + 2; max++) {
      expect(loneSurrogates(clipTextEnd(s, max))).toBe(0);
    }
  });

  test("a HIGH surrogate at the start is left alone: it is the start that makes orphans", () => {
    // The mirror of its sibling's rule. An orphan already in the input belongs to
    // replaceLoneSurrogates.
    const lone = JSON.parse('"ab\ud800cd"') as string;
    expect(loneSurrogates(clipTextEnd(lone, 3))).toBe(1);
  });
});

describe("replaceLoneSurrogates", () => {
  const HIGH = JSON.parse('"pre\\ud800post"') as string;
  const LOW = JSON.parse('"pre\\udc00post"') as string;
  const PAIR = "pre😀post";

  test("a well-formed pair is untouched, and the string is returned as-is", () => {
    expect(replaceLoneSurrogates(PAIR)).toBe(PAIR);
  });
  test("plain text is untouched", () => {
    expect(replaceLoneSurrogates("nothing to do here")).toBe(
      "nothing to do here",
    );
  });
  test("an orphan HIGH surrogate becomes U+FFFD", () => {
    expect(replaceLoneSurrogates(HIGH)).toBe("pre�post");
  });
  test("an orphan LOW surrogate becomes U+FFFD", () => {
    expect(replaceLoneSurrogates(LOW)).toBe("pre�post");
  });
  test("a high surrogate at the very end is an orphan", () => {
    const s = JSON.parse('"tail\\ud83d"') as string;
    expect(loneSurrogates(replaceLoneSurrogates(s))).toBe(0);
  });
  test("two orphans in a row are both replaced, and a pair between them survives", () => {
    const s = JSON.parse('"\\ud800a😀b\\udfff"') as string;
    const out = replaceLoneSurrogates(s);
    expect(loneSurrogates(out)).toBe(0);
    expect(out).toContain("😀");
    expect(out).toBe("�a😀b�");
  });
  test("is idempotent", () => {
    const once = replaceLoneSurrogates(HIGH);
    expect(replaceLoneSurrogates(once)).toBe(once);
  });
});

// The DATABASE's rule, which is not the renderer's and not the model's: what a `text` or `jsonb`
// column physically refuses. Narrow on purpose — a value can be perfectly storable and impossible to
// draw (an emoji in a tool description nobody prints), and conflating the two puts a rule with no
// reason behind it in front of an operator.
describe("unstorableProblem", () => {
  test("names a NUL and half a character, by code point", () => {
    const nul = unstorableProblem(`a\u0000b`, "key");
    expect(nul).toContain("U+0000");
    expect(nul).toContain("key");
    // The character itself is never pasted into the message: a NUL would ride into a log line and an
    // API response, and half a character into a JSON body.
    expect(JSON.stringify(nul)).not.toContain("\u0000");

    const orphan = unstorableProblem(`a\ud800b`, "description");
    expect(orphan).toContain("U+D800");
    expect(JSON.stringify(orphan)).not.toContain("\\ud8");
    // Either half, because a JSON body can spell out either one.
    expect(unstorableProblem(`a\udc00b`, "x")).toContain("U+DC00");
  });

  test("accepts everything a column can actually hold", () => {
    // Including the two that a printability check would refuse and this one must not: a WELL-FORMED
    // astral character, and a control that is not NUL. Postgres stores both.
    for (const value of ["Ana", "😀", "a\tb", "a\nb", "Orçamento", ""]) {
      expect(unstorableProblem(value, "x")).toBeNull();
    }
  });
});

// The REPAIR half of the same rule `unstorableProblem` reports: same predicate, opposite policy.
// Refusing is right where the author reads the refusal and can fix the value (an operator's form);
// repairing is right where the writer is a third party's webhook that will never read the refusal
// and whose only recourse is to retry the identical body forever.
describe("makeStorable", () => {
  // Written as a code unit rather than pasted: a literal NUL in a source file is invisible in every
  // diff and every review.
  const NUL = String.fromCharCode(0);

  test("drops a NUL and replaces half a character, in every position", () => {
    expect(makeStorable(`a${NUL}b`)).toBe("ab");
    expect(makeStorable(`${NUL}ab`)).toBe("ab");
    expect(makeStorable(`ab${NUL}`)).toBe("ab");
    expect(makeStorable("a\ud800b")).toBe("a�b");
    expect(makeStorable("a\udc00b")).toBe("a�b");
    // Both defects in one value, which is what a truncating upstream actually produces.
    expect(makeStorable(`a${NUL}b\ud800c`)).toBe("ab�c");
  });

  test("does not let a dropped NUL join two orphan halves into a character", () => {
    // Three defects, and dropping the NUL FIRST would leave `\ud800\udc00` adjacent, which is the
    // well-formed pair U+10000: a character nobody wrote, surviving the repair intact.
    const out = makeStorable(`\ud800${NUL}\udc00`);
    expect(out).toBe("��");
    expect([...out].map((c) => c.codePointAt(0))).toEqual([0xfffd, 0xfffd]);
  });

  test("leaves everything a column can hold exactly as it was", () => {
    for (const value of ["Ana", "\u{1f600}", "a\tb", "a\nb", "Orcamento", ""]) {
      expect(makeStorable(value)).toBe(value);
    }
  });

  test("its output is what unstorableProblem accepts, which is the whole point", () => {
    for (const value of [`a${NUL}b`, "a\ud800b", "a\udc00b", `${NUL}\ud800`]) {
      expect(unstorableProblem(value, "x")).not.toBeNull();
      expect(unstorableProblem(makeStorable(value), "x")).toBeNull();
    }
  });

  test("is idempotent", () => {
    const once = makeStorable(`a${NUL}b\ud800c`);
    expect(makeStorable(once)).toBe(once);
  });
});

// One orphan half ANYWHERE in a document is enough for Postgres to refuse the whole `jsonb` write,
// so the unit that has to come back storable is the document, not the field.
describe("makeStorableDeep", () => {
  const NUL = String.fromCharCode(0);
  // The predicate the whole function exists for: nothing a column refuses survives anywhere in the
  // result. Asserted on the SERIALIZED document, so a value the test forgot to name still counts.
  function residue(value: unknown): number {
    const json = JSON.stringify(value) ?? "";
    return (json.match(/\\u0000/g)?.length ?? 0) + loneSurrogates(json);
  }

  test("repairs values, keys, and everything nested inside either", () => {
    const out = makeStorableDeep({
      [`k${NUL}1`]: "clean",
      k2: `v\ud800`,
      nested: { [`k\ud800`]: [`a${NUL}b`, { deep: `c\udc00` }] },
    }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["k1", "k2", "nested"]);
    expect(out.k2).toBe("v�");
    expect(out.nested).toEqual({ "k�": ["ab", { deep: "c�" }] });
    expect(residue(out)).toBe(0);
  });

  test("keeps a `__proto__` key as a field instead of feeding it to the prototype setter", () => {
    // `JSON.parse` produces `__proto__` as an ordinary own property, so a third party's body can
    // carry one, and a malformed key can repair INTO one. Plain assignment would invoke the legacy
    // setter: the field disappears from what gets persisted and the copy's prototype changes.
    const raw = JSON.parse(`{"__pro${"\\u0000"}to__": {"a": 1}, "keep": "x"}`);
    const out = makeStorableDeep(raw) as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(out).sort()).toEqual([
      "__proto__",
      "keep",
    ]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    // What actually reaches the column is the serialization, which is where the loss shows up.
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      __proto__: { a: 1 },
      keep: "x",
    });
  });

  test("leaves a clean document, its non-strings, and its Dates alone", () => {
    const date = new Date("2026-08-24T00:00:00.000Z");
    const input = { s: "Ana", n: 1, b: true, nul: null, date, list: [1, "x"] };
    const out = makeStorableDeep(input);
    expect(out).toEqual(input);
    // The Date is the reason a non-plain object is returned as it is: rebuilding it from its
    // entries (there are none) would silently turn a timestamp into `{}`.
    expect(out.date).toBe(date);
  });

  test("drops the branch below the depth cap rather than passing it through unrepaired", () => {
    // 12 levels: deeper than any allowlisted projection, and deep enough to be past the cap.
    let deep: unknown = `bottom\ud800`;
    for (let i = 0; i < 12; i++) deep = { down: deep };
    const out = makeStorableDeep(deep);
    expect(residue(out)).toBe(0);
    expect(JSON.stringify(out)).toContain("null");
  });
});
