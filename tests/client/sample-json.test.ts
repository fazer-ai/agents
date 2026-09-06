import { describe, expect, test } from "bun:test";
import { firstJsonProblem, reindentJson } from "@/client/lib/sampleJson";

// WHERE THE SAMPLE BREAKS, AND HOW IT IS TIDIED WITHOUT BEING CHANGED (issue #562).
//
// Two jobs that look like one. Both are about a pasted API response, and both refuse to go through
// `JSON.parse`, for two different reasons.

describe("firstJsonProblem", () => {
  test("says nothing about a document that parses", () => {
    expect(firstJsonProblem('{"a": [1, 2], "b": null}')).toBeNull();
  });

  // THE ENGINE'S MESSAGE IS NOT AN ANSWER, which is why this reads a parse of our own.
  //
  // Measured on the shapes below: V8 locates three of the four and gives up on the first, JSC (Bun,
  // and Safari, which is a browser operators use) locates none of them and answers `Expected '}'`,
  // and every one of those sentences is the engine's own English with no translation and no shape a
  // reader can rely on. The syntax tree answers the same question in every engine, in one number.
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

  // THE COORDINATES ARE ABOUT THE TEXT ON SCREEN, which is the whole point of reporting them.
  //
  // Round 1 of review: the field trimmed before asking, so a paste with blank lines above it was
  // measured against a string the operator is not looking at and pointed at line 1 for a break on
  // line 3. Whatever normalizing happens, happens in here, and what comes back is a place in the
  // document as given.
  test("counts lines from the document it was given, not from a trimmed copy", () => {
    expect(firstJsonProblem('\n\n  {"a": }')).toEqual({
      offset: 10,
      line: 3,
      column: 9,
    });
  });

  // A response is not a fragment: two objects pasted back to back are a mistake worth naming, and
  // `JSON.parse` names it too. What must not happen is the tree reporting only the first value and
  // calling the rest fine.
  test("counts trailing content as a break", () => {
    expect(firstJsonProblem('{"a": 1} {"b": 2}')).not.toBeNull();
  });
});

describe("reindentJson", () => {
  test("expands a minified response and keeps what it says", () => {
    const text = '{"data":{"id":"ap_1","tags":["a","b"],"ok":true}}';
    expect(reindentJson(text)).toBe(
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

  // IT REWRITES THE OPERATOR'S OWN PASTE, so what it writes back has to say the same thing.
  //
  // `JSON.stringify(JSON.parse(text), null, 2)` is the obvious implementation and it is wrong here,
  // measured: it turns `12345678901234567890` into `12345678901234567000` (a real id, silently
  // wrong, and then picked from the offer as the value the API returns), `1.0` into `1`, `1e3` into
  // `1000`, and it drops the earlier of two duplicate keys. Formatting is not the moment to decide
  // what a response really meant. So the literals are copied out of the document verbatim and only
  // the whitespace between them is ours.
  test("does not round-trip literals through a JavaScript number", () => {
    const out = reindentJson(
      '{"id":12345678901234567890,"price":1.0,"big":1e3}',
    );
    expect(out).toContain("12345678901234567890");
    expect(out).toContain("1.0");
    expect(out).toContain("1e3");
  });

  test("keeps both of two keys that collide", () => {
    const out = reindentJson('{"dup":1,"dup":2}') ?? "";
    expect(out.match(/"dup"/g)?.length).toBe(2);
    expect(out).toContain("1");
    expect(out).toContain("2");
  });

  test("keeps a string's own escapes and its inner braces", () => {
    const text = '{"note":"a \\"quoted\\" {word}, and a \\\\ slash"}';
    const out = reindentJson(text) ?? "";
    expect(out).toContain('"a \\"quoted\\" {word}, and a \\\\ slash"');
    // And what it produced still parses to the same thing.
    expect(JSON.parse(out)).toEqual(JSON.parse(text));
  });

  // A BOM IS NOT A VALUE, and the field already decided that.
  //
  // Round 1 of review: a paste that begins with a byte-order mark parses here (`String.trim` counts
  // U+FEFF as whitespace, so `JSON.parse` gets a clean document and the pickers fill), and the
  // formatter refused it — an enabled button that did nothing when clicked, which is the silent
  // refusal this feature exists to remove. The two now normalize the same way. Nothing of the
  // operator's is dropped: a BOM is an encoding marker, not something the response says.
  test("formats a document that opens with a byte-order mark", () => {
    expect(reindentJson('\uFEFF{"a":1}')).toBe(`{
  "a": 1
}`);
  });

  test("formats a document padded with whitespace", () => {
    expect(reindentJson('  {"a":1}\n\n')).toBe(`{
  "a": 1
}`);
  });

  test("leaves an empty object and an empty array on one line", () => {
    expect(reindentJson('{"a":{},"b":[]}')).toBe(
      `{
  "a": {},
  "b": []
}`,
    );
  });

  test("is idempotent: formatting what it produced changes nothing", () => {
    const once = reindentJson('{"a":[1,{"b":2}],"c":"x"}') ?? "";
    expect(reindentJson(once)).toBe(once);
  });

  // NEVER "FIXES" WHAT IT COULD NOT READ. The operator pasted that from somewhere and cannot get it
  // back from us, so a document that does not parse is returned untouched and the refusal is said
  // elsewhere, by the position above.
  test("refuses a document it cannot read, instead of repairing it", () => {
    expect(reindentJson('{"a": 1, "b": }')).toBeNull();
    expect(reindentJson("")).toBeNull();
  });
});
