import { describe, expect, test } from "bun:test";
import { clipText, clipTextEnd, replaceLoneSurrogates } from "@/lib/text";

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
