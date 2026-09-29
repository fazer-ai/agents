import { describe, expect, test } from "bun:test";
import { firstJsonProblem, reindentJson } from "@/client/lib/sampleJson";

// WHERE THE SAMPLE BREAKS, AND HOW IT IS TIDIED WITHOUT BEING CHANGED.
//
// Two jobs that look like one. Both are about a pasted API response, and both refuse to go through
// `JSON.parse`, for two different reasons.

describe("firstJsonProblem", () => {
  test("says nothing about a document that parses", () => {
    expect(firstJsonProblem('{"a": [1, 2], "b": null}')).toBeNull();
  });

  // NOTE: the engine's message is not an answer, which is why this reads a parse of our own. V8
  // locates only some of the shapes below and JSC (Bun, and Safari, which operators use) locates
  // none, each in its own untranslated English; the syntax tree answers in every engine, in one number.
  test("locates a break the engine's own message cannot", () => {
    // `JSON.parse` here says only: Unexpected token '}', "…" is not valid JSON.
    expect(firstJsonProblem('{"a": 1, "b": }')).toEqual({
      offset: 14,
      line: 1,
      column: 15,
    });
  });

  test("locates a missing comma on the line that is missing it", () => {
    expect(firstJsonProblem('{"a": 1,\n  "b": 2\n  "c": 3\n}')).toEqual({
      offset: 20,
      line: 3,
      column: 3,
    });
  });

  test("locates an unquoted key, and a document that stops early", () => {
    expect(firstJsonProblem("{a: 1}")).toEqual({
      offset: 1,
      line: 1,
      column: 2,
    });
    expect(firstJsonProblem('{"a": 1')).toEqual({
      offset: 7,
      line: 1,
      column: 8,
    });
  });

  // NOTE: the coordinates are about the text on screen. A paste with blank lines above it must not be
  // measured against a trimmed copy the operator is not looking at: whatever normalizing happens,
  // happens in here, and what comes back is a place in the document as given.
  test("counts lines from the document it was given, not from a trimmed copy", () => {
    expect(firstJsonProblem('\n\n  {"a": }')).toEqual({
      offset: 10,
      line: 3,
      column: 9,
    });
  });

  // NOTE: the column is counted in characters, because a person counts characters. The offset is a
  // UTF-16 index and an emoji is two of those, and API responses carry emoji routinely, so counting
  // units would name a column one past the break per astral character.
  test("counts a column in characters, not in UTF-16 units", () => {
    // The `}` is the seventh character of the line and the eighth UTF-16 unit.
    expect(firstJsonProblem('{"\u{1F600}": }')).toEqual({
      offset: 7,
      line: 1,
      column: 7,
    });
  });

  // NOTE: a line break is whatever the editor draws as one. CodeMirror breaks on `\r\n?|\n`, so a bare
  // CR is a line on screen. Typing and pasting normalize it away, but "Send a test request" writes the
  // RAW response body here, and an HTTP body is whatever the server sent.
  test("counts a bare carriage return as the line break the editor draws", () => {
    expect(firstJsonProblem("{\r  a}")).toEqual({
      offset: 4,
      line: 2,
      column: 3,
    });
  });

  test("counts a CRLF pair as one break", () => {
    expect(firstJsonProblem("{\r\n  a}")).toEqual({
      offset: 5,
      line: 2,
      column: 3,
    });
  });

  // NOTE: an unfinished document ends where the operator's cursor is: at the end of the text on
  // screen, not of its trimmed body. Blank lines under an unclosed brace are exactly where a person is
  // when this message appears.
  test("points at the end of the document as shown when it just stops", () => {
    expect(firstJsonProblem('{"a":1\n\n')).toEqual({
      offset: 8,
      line: 3,
      column: 1,
    });
    expect(firstJsonProblem('{"a":1   ')).toEqual({
      offset: 9,
      line: 1,
      column: 10,
    });
  });

  // A response is not a fragment: two objects pasted back to back are a mistake worth naming, and
  // `JSON.parse` names it too. What must not happen is the tree reporting only the first value and
  // calling the rest fine.
  test("counts trailing content as a break", () => {
    expect(firstJsonProblem('{"a": 1} {"b": 2}')).not.toBeNull();
  });
});

// The text it produced, or null for either refusal. The tests that care about WHICH refusal ask the
// result itself; everything else is about what came out.
function tidy(text: string): string | null {
  const r = reindentJson(text);
  return r.ok ? r.text : null;
}

describe("reindentJson", () => {
  test("expands a minified response and keeps what it says", () => {
    const text = '{"data":{"id":"ap_1","tags":["a","b"],"ok":true}}';
    expect(tidy(text)).toBe(
      `{
  "data": {
    "id": "ap_1",
    "tags": [
      "a",
      "b"
    ],
    "ok": true
  }
}`,
    );
  });

  // NOTE: it rewrites the operator's own paste, so what it writes back has to say the same thing.
  // `JSON.stringify(JSON.parse(text), null, 2)` is wrong here: it turns `12345678901234567890` into
  // `12345678901234567000` (an id, silently wrong, then picked from the offer), `1.0` into `1`, `1e3`
  // into `1000`, and drops the earlier of two duplicate keys. So literals are copied out verbatim and
  // only the whitespace between them is ours.
  test("does not round-trip literals through a JavaScript number", () => {
    const out = tidy('{"id":12345678901234567890,"price":1.0,"big":1e3}');
    expect(out).toContain("12345678901234567890");
    expect(out).toContain("1.0");
    expect(out).toContain("1e3");
  });

  test("keeps both of two keys that collide", () => {
    const out = tidy('{"dup":1,"dup":2}') ?? "";
    expect(out.match(/"dup"/g)?.length).toBe(2);
    expect(out).toContain("1");
    expect(out).toContain("2");
  });

  test("keeps a string's own escapes and its inner braces", () => {
    const text = '{"note":"a \\"quoted\\" {word}, and a \\\\ slash"}';
    const out = tidy(text) ?? "";
    expect(out).toContain('"a \\"quoted\\" {word}, and a \\\\ slash"');
    // And what it produced still parses to the same thing.
    expect(JSON.parse(out)).toEqual(JSON.parse(text));
  });

  // NOTE: a BOM is not a value. A paste that opens with one parses in the field (`String.trim` counts
  // U+FEFF as whitespace), so the formatter normalizes the same way; refusing it would leave an
  // enabled button that does nothing. Nothing of the operator's is dropped: a BOM is an encoding marker.
  test("formats a document that opens with a byte-order mark", () => {
    expect(tidy('\uFEFF{"a":1}')).toBe(`{
  "a": 1
}`);
  });

  test("formats a document padded with whitespace", () => {
    expect(tidy('  {"a":1}\n\n')).toBe(`{
  "a": 1
}`);
  });

  test("leaves an empty object and an empty array on one line", () => {
    expect(tidy('{"a":{},"b":[]}')).toBe(
      `{
  "a": {},
  "b": []
}`,
    );
  });

  test("is idempotent: formatting what it produced changes nothing", () => {
    const once = tidy('{"a":[1,{"b":2}],"c":"x"}') ?? "";
    expect(tidy(once)).toBe(once);
  });

  // NEVER "FIXES" WHAT IT COULD NOT READ. The operator pasted that from somewhere and cannot get it
  // back from us, so a document that does not parse is returned untouched and the refusal is said
  // elsewhere, by the position above.
  test("refuses a document it cannot read, instead of repairing it", () => {
    expect(reindentJson('{"a": 1, "b": }')).toEqual({
      ok: false,
      why: "unreadable",
    });
    expect(reindentJson("")).toEqual({ ok: false, why: "unreadable" });
  });
});

// FORMATTING IS FOR READING, AND IT HAS A CEILING.
//
// Indentation is depth-sized, so a deeply nested document expands by a factor of its depth: 4001
// characters of nested arrays produce 8,008,001, from a document well under the 100,000-char cap the
// test endpoint puts on a raw response. That output is re-parsed on the next keystroke and produced
// automatically when a test request answers, so the writer carries a budget and gives up instead.
describe("reindentJson under a ceiling", () => {
  function nested(depth: number): string {
    let doc = "1";
    for (let i = 0; i < depth; i++) doc = `[${doc}]`;
    return doc;
  }

  // NOTE: named, not merely refused: the field says which of the two happened, because a disabled
  // button beside a sentence about something else says nothing.
  test("refuses a document whose formatted form nobody could read", () => {
    expect(reindentJson(nested(2000))).toEqual({ ok: false, why: "too-large" });
  });

  test("still formats an ordinary response", () => {
    const wide = JSON.stringify({
      data: Array.from({ length: 500 }, (_, i) => ({
        id: `ap_${i}`,
        name: `Nome ${i}`,
        at: "2026-09-02T14:00:00-03:00",
      })),
    });
    const out = tidy(wide);
    expect(out).not.toBeNull();
    expect(JSON.parse(out ?? "")).toEqual(JSON.parse(wide));
  });

  // The ceiling is on the OUTPUT, not on the input: what makes a document unreadable here is what
  // comes out of it, and a small input is exactly how the big output is reached.
  test("judges the formatted size, not the pasted size", () => {
    expect(nested(2000).length).toBeLessThan(10_000);
    expect(reindentJson(nested(2000))).toEqual({ ok: false, why: "too-large" });
  });
});
