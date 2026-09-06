import { describe, expect, test } from "bun:test";
import { commentSpans } from "@/tests/utils/source-text";

// WHERE THE TAG DOES NOT GO, AND WHY THE ANSWER HAD TO BE A CHECK.
//
// `CLAUDE.md` asks for a `TODO:`/`NOTE:`/`FIXME:` tag on a comment inside a body, and exempts the
// comment that DOCUMENTS a symbol. Read literally, a JSX comment sits inside a component's body and
// needs the tag. The tree never did that, and the disagreement was invisible until a reviewer quoted
// the rule at one diff: it cost a waiver on #550 and the issue (#553) that this file closes.
//
// THE MEASUREMENT THAT DECIDED IT, rather than a preference. The rule is alive where it is about
// code: `src/**/*.ts` carries 927 tagged in-body comments. In JSX it is not practised at all — 8 of
// 140. And the 8 are not a different KIND of comment from the 132: "`relative` is load-bearing",
// "a Select, not a Switch: this knob has THREE states", "Shown for generated too, because…" all
// document the element directly below them, exactly like the untagged "The toggle and the filter
// shortcut are SIBLINGS rather than nested, because…". There was no distinction to apply, so the tag
// in markup recorded who had been asked for it, not what the comment was.
//
// So the rule now says a JSX comment documents the element below it — the same shape as a docstring
// above a declaration — and carries no `NOTE:`. This file is that sentence as a check, because a
// convention nobody can measure is one argument per PR that adds a comment to markup.
//
// `TODO:` AND `FIXME:` STAY ALLOWED, and the asymmetry is the point. `NOTE:` marks an aside, which is
// what a JSX comment already is by position; the other two mark WORK that is owed, and pending work
// in markup is still pending work. Nothing in the tree writes them in JSX today, and this check is
// not what should stop the first one.
//
// THE OTHER HALF OF THE RULE IS NOT FENCED HERE, DELIBERATELY. A machine directive cannot carry a tag
// at all: prefixing `NOTE: ` on `{/* biome-ignore lint/plugin/no-dynamic-i18n-key: … */}` in
// AuditPage.tsx makes biome report `Found 1 error` on a file that was clean, because the suppression
// stops being one and the rule it suppressed fires again. There are 108 such directives in `src/`.
// The toolchain already refuses that mistake loudly on every run, so `CLAUDE.md` states the reason
// and no second gate repeats the first.

const TAG = /\b(NOTE|TODO|FIXME):/;
// Only `NOTE:` is refused. See the asymmetry above.
const ASIDE_TAG = /\bNOTE:/;

// A JSX comment is a BLOCK comment whose only wrapper is the expression braces: `{/* … */}`. The walk
// is backwards and forwards over whitespace rather than `trimEnd()` on a slice, so a 22k-character
// file is not copied once per comment in it.
//
// THE `/*` IS LOAD-BEARING, AND THE SECOND SPELLING IS WHY. A comment between braces can also be
// written with `//` across lines, so that shape was measured before trusting this one: 30 sites in
// `src/client` match `{` + line comment + `}` and NONE of them is markup — they are empty `catch { }`
// bodies, and one of them (BehaviorTab.tsx:602, `// NOTE: best-effort — the pickers still accept
// typed keys`) carries a tag it is right to carry. A detector without this line would have demanded
// its removal, which is the rule inverted rather than enforced.
function isJsxComment(src: string, start: number, end: number): boolean {
  if (!src.startsWith("/*", start)) return false;
  let before = start - 1;
  while (before >= 0 && /\s/.test(src[before] as string)) before--;
  let after = end;
  while (after < src.length && /\s/.test(src[after] as string)) after++;
  return src[before] === "{" && src[after] === "}";
}

describe("a comment in markup documents the element below it, and carries no NOTE:", () => {
  test("no JSX comment in src/client is tagged", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    let seen = 0;
    for await (const rel of new Glob("**/*.tsx").scan("src/client")) {
      const path = `src/client/${rel}`;
      const src = await Bun.file(path).text();
      for (const [start, end] of commentSpans(src)) {
        if (!isJsxComment(src, start, end)) continue;
        seen++;
        const text = src.slice(start, end);
        if (!ASIDE_TAG.test(text)) continue;
        const line = src.slice(0, start).split("\n").length;
        offenders.push(
          `${path}:${line}  ${text.slice(0, 60).replace(/\s+/g, " ")}`,
        );
      }
    }
    expect(offenders).toEqual([]);
    // …AND THE SWEEP IS LOOKING AT SOMETHING. A detector that stops recognising `{/* … */}` reports
    // a clean tree, which is the same output as a clean tree. 140 today; the floor is what a
    // refactor of the client would have to fall below before this file quietly stopped checking.
    expect(seen).toBeGreaterThanOrEqual(100);
  });
});

describe("the detector is not fooled by prose that spells the shape", () => {
  test("a JSX comment inside a string literal is not a comment", () => {
    const src = 'const sample = "{/* NOTE: not a comment */}";\n';
    expect(commentSpans(src)).toEqual([]);
  });

  test("a tag in a code comment beside markup is untouched", () => {
    const src =
      "function C() {\n  // NOTE: an aside about code\n  return <div />;\n}\n";
    const [span] = commentSpans(src);
    expect(span).toBeDefined();
    const [start, end] = span as [number, number];
    expect(TAG.test(src.slice(start, end))).toBe(true);
    expect(isJsxComment(src, start, end)).toBe(false);
  });

  test("an empty catch body between braces is not markup", () => {
    // The second spelling, and the reason the detector asks for `/*`. This shape is a code body, and
    // the comment in it is an in-body aside that the rule wants tagged.
    const src = "try {\n  risky();\n} catch {\n  // NOTE: best-effort\n}\n";
    const [span] = commentSpans(src);
    const [start, end] = span as [number, number];
    expect(src.slice(start, end)).toBe("// NOTE: best-effort");
    expect(isJsxComment(src, start, end)).toBe(false);
  });

  test("a JSX comment is recognised across lines", () => {
    const src =
      "const x = (\n  <div>\n    {/* NOTE: two\n        lines */}\n  </div>\n);\n";
    const [span] = commentSpans(src);
    const [start, end] = span as [number, number];
    expect(isJsxComment(src, start, end)).toBe(true);
    expect(src.slice(start, end)).toContain("lines */");
  });
});
