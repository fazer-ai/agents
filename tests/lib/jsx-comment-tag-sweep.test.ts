import { describe, expect, test } from "bun:test";
import { commentSpans } from "@/tests/utils/source-text";

// A JSX comment documents the element below it, so it carries no `NOTE:` (`CLAUDE.md`, "Where the
// tag goes"). `TODO:` and `FIXME:` stay allowed: they mark owed work, which is owed in markup too.
// A tagged machine directive is not fenced here: biome already fails it on every run.

const TAG = /\b(NOTE|TODO|FIXME):/;
// Only `NOTE:` is refused. See the asymmetry above.
const ASIDE_TAG = /\bNOTE:/;

// A JSX comment is a block comment the braces hug (`{/* ... */}`). Biome breaks a lone block comment
// in a code body, where the tag IS required, onto its own line, so adjacency separates the two
// without a heuristic, and still finds a container after JSX text (`label {/* ... */}`), which a
// check on what precedes the brace would skip. The formatter test below fails if biome changes.
function isJsxComment(src: string, start: number, end: number): boolean {
  return (
    src.startsWith("/*", start) && src[start - 1] === "{" && src[end] === "}"
  );
}

// Two counts of the same shape. `commentSpans` does not understand JSX text (header of
// `tests/utils/source-text.ts`): a quote or a non-HTTP `scheme://` in visible text swallows a
// `{/* ... */}`, which then passes the gate unseen. The raw pattern counts a string literal that
// spells the shape, so it is a cross-check and never the gate: a divergence needs a person to look.
function jsxComments(src: string): {
  spans: Array<[number, number]>;
  raw: number;
} {
  return {
    spans: commentSpans(src).filter(([start, end]) =>
      isJsxComment(src, start, end),
    ),
    raw: (src.match(/\{\/\*[\s\S]*?\*\/\}/g) ?? []).length,
  };
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

// The sweep over (path, source) pairs rather than the glob, so a fixture tree can prove the wiring:
// an unpopulated `blind` list and an unexercised assertion both read as a healthy tree.
function auditTree(files: Array<[string, string]>): {
  offenders: string[];
  blind: string[];
  seen: number;
} {
  const offenders: string[] = [];
  const blind: string[] = [];
  let seen = 0;
  for (const [path, src] of files) {
    const { spans, raw } = jsxComments(src);
    seen += spans.length;
    for (const [start, end] of spans) {
      const text = src.slice(start, end);
      if (!ASIDE_TAG.test(text)) continue;
      const line = src.slice(0, start).split("\n").length;
      offenders.push(
        `${path}:${line}  ${text.slice(0, 60).replace(/\s+/g, " ")}`,
      );
    }
    if (raw !== spans.length) {
      blind.push(`${path}: scan ${spans.length}, raw ${raw}`);
    }
  }
  return { offenders, blind, seen };
}

describe("a comment in markup documents the element below it, and carries no NOTE:", () => {
  test("no JSX comment under src/ is tagged, and none is hidden from the scan", async () => {
    const { Glob } = await import("bun");
    // NOTE: every `.tsx` in `src`, not just the client: `src/modules/documents/render.tsx` renders
    // JSX that a glob rooted at the console would never see.
    const files: Array<[string, string]> = [];
    for await (const rel of new Glob("**/*.tsx").scan("src")) {
      files.push([`src/${rel}`, await Bun.file(`src/${rel}`).text()]);
    }
    const { offenders, blind, seen } = auditTree(files);
    expect(blind).toEqual([]);
    expect(offenders).toEqual([]);
    // NOTE: ...and the sweep is looking at something: a detector that stops recognising `{/* */}`
    // reports the same output as a clean tree. The floor sits below today's count.
    expect(seen).toBeGreaterThanOrEqual(100);
  });

  test("the sweep reports a file the scan cannot see into, instead of skipping it", () => {
    // The wiring, driven over a fixture tree: one healthy file and one whose visible text carries a
    // quote. Removing the cross-check from the loop is invisible against the real tree, where nothing
    // diverges, and fails here.
    const { offenders, blind, seen } = auditTree([
      ["ok.tsx", "const a = <p>label {/* fine */}</p>;\n"],
      [
        "hidden.tsx",
        'const b = <p>He said "hi {/* NOTE: hidden */} bye"</p>;\n',
      ],
    ]);
    expect(blind).toEqual(["hidden.tsx: scan 0, raw 1"]);
    // …and the tag really is invisible to the gate, which is why the count above has to speak.
    expect(offenders).toEqual([]);
    expect(seen).toBe(1);
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

    // NOTE: ...and the container survives the same pass hugging, including the one after JSX text,
    // which a check on what precedes the brace would skip.
    const markup =
      "const el = (\n  <div>\n    label {/* NOTE: after text */}\n    <X />\n    {ok && <Y />}{/* NOTE: after a container */}\n  </div>\n);\n";
    const out = await format(markup);
    const spans = commentSpans(out).filter(([s]) => out.startsWith("/*", s));
    expect(spans.length).toBe(2);
    for (const [start, end] of spans) {
      expect(isJsxComment(out, start, end)).toBe(true);
    }
  });

  test("a quote in JSX text hides a comment, and the raw count is what says so", () => {
    // The premise under the cross-check in the sweep, driven rather than asserted. Both shapes are
    // ones the shared scan is documented not to handle, and in both the raw pattern still sees the
    // comment the scan lost.
    for (const src of [
      'const x = <p>He said "hi {/* NOTE: hidden */} bye"</p>;\n',
      "const x = <p>ws://host {/* NOTE: hidden */}</p>;\n",
    ]) {
      const { spans, raw } = jsxComments(src);
      expect(spans.length).toBe(0);
      expect(raw).toBe(1);
    }
    // …and a healthy file agrees with itself, which is what the sweep requires of every file.
    const healthy = "const x = <p>label {/* NOTE: seen */}</p>;\n";
    const both = jsxComments(healthy);
    expect(both.spans.length).toBe(1);
    expect(both.raw).toBe(1);
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
