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

// A JSX comment is a block comment the braces HUG: `{/*` … `*/}`, with nothing between them. The
// adjacency is not a style preference, it is what the formatter already decides, and the formatter
// runs in CI on every file.
//
// THE TWO CASES THIS SEPARATES ARE OPPOSITE HALVES OF THE RULE, and review named both. A block
// comment can also be the whole content of a CODE body — `useEffect(() => { /* NOTE: empty */ }, [])`
// — where the tag is REQUIRED, so a check that stopped at "braces around a comment" would report a
// correct comment as an offence. And a container can follow plain JSX text — `label {/* … */}` —
// where a check that asked what precedes the brace would silently skip a real site.
//
// Biome answers both without a heuristic: it breaks a lone block comment in a body onto its own line
// (`{\n  /* … */\n}`) and leaves a JSX container hugging (`{/* … */}`). Measured over `src/**/*.tsx`:
// 140 comments sit between braces and all 140 hug; zero sit between braces without hugging. The test
// below drives the real formatter over the body shapes and requires it to keep separating them, so
// this file fails if that behaviour ever changes rather than quietly changing what it enforces.
function isJsxComment(src: string, start: number, end: number): boolean {
  return (
    src.startsWith("/*", start) && src[start - 1] === "{" && src[end] === "}"
  );
}

// The formatter as the suite runs it, over stdin so nothing is written to the tree.
async function format(source: string): Promise<string> {
  const proc = Bun.spawn(
    ["./node_modules/.bin/biome", "format", "--stdin-file-path=probe.tsx"],
    { stdin: new TextEncoder().encode(source), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`biome format failed: ${err}`);
  return out;
}

describe("a comment in markup documents the element below it, and carries no NOTE:", () => {
  test("no JSX comment in src/client is tagged", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    let seen = 0;
    // EVERY `.tsx` IN `src`, not just the client. `src/modules/documents/render.tsx` renders JSX for
    // the document pipeline and a glob rooted at the console would never look at it (review, round 2).
    for await (const rel of new Glob("**/*.tsx").scan("src")) {
      const path = `src/${rel}`;
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

  test("the formatter is what separates a code body from a container", async () => {
    // THE ASSUMPTION UNDER `isJsxComment`, EXERCISED AGAINST THE REAL BINARY rather than asserted.
    // If biome ever starts leaving a lone block comment hugging the braces of a body, the adjacency
    // test stops telling the two apart, and this is the test that says so.
    const bodies = [
      "useEffect(() => {/* NOTE: intentionally empty */}, []);\n",
      "try {\n  risky();\n} catch {/* NOTE: ignore */}\n",
      "const pending = {/* NOTE: filled in by the caller */};\n",
    ];
    for (const body of bodies) {
      const out = await format(body);
      const [span] = commentSpans(out);
      const [start, end] = span as [number, number];
      expect(isJsxComment(out, start, end)).toBe(false);
    }

    // …and the container survives the same pass hugging, including the one that follows JSX text,
    // which is the shape a "what precedes the brace" test would have skipped (review, round 2).
    const markup =
      "const el = (\n  <div>\n    label {/* NOTE: after text */}\n    <X />\n    {ok && <Y />}{/* NOTE: after a container */}\n  </div>\n);\n";
    const out = await format(markup);
    const spans = commentSpans(out).filter(([s]) => out.startsWith("/*", s));
    expect(spans.length).toBe(2);
    for (const [start, end] of spans) {
      expect(isJsxComment(out, start, end)).toBe(true);
    }
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
