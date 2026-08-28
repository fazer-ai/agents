import { describe, expect, test } from "bun:test";
import {
  codeOnly,
  countInSrc,
  unterminatedLiteral,
  withoutComments,
} from "@/tests/utils/source-text";

// The table for the scan every source sweep now counts through, and the two directions it has to be
// right in. Reading LESS than the file is the cheap failure — a phantom site, red CI, someone
// annoyed. Reading MORE is the expensive one: a swallowed region is a site the sweep silently stops
// counting, which is the same shape as the false waiver #424 exists to prevent, reached from the
// other side. So every row below asserts BOTH what goes and what stays.

const CUT = /\.slice\(\s*0\s*,/g;
const hits = (s: string) => (s.match(CUT) ?? []).length;

describe("the scan removes prose and keeps code", () => {
  const REMOVED: [string, string][] = [
    ["line comment", "// a cut: s.slice(0, 1)\n"],
    ["block comment", "/* a cut: s.slice(0, 1) */\n"],
    ["jsdoc", "/**\n * a cut: s.slice(0, 1)\n */\n"],
    ["comment after code", "const a = 1; // s.slice(0, 1)\n"],
    ["double-quoted string", 'const a = "s.slice(0, 1)";\n'],
    ["single-quoted string", "const a = 's.slice(0, 1)';\n"],
    ["template literal", "const a = `s.slice(0, 1)`;\n"],
    [
      "template around an interpolation",
      `const a = \`s.slice(0, 1) \${x}\`;\n`,
    ],
  ];
  for (const [name, source] of REMOVED) {
    test(`${name} is not a cut`, () => {
      expect(hits(source)).toBe(1);
      expect(hits(codeOnly(source))).toBe(0);
    });
  }

  const KEPT: [string, string][] = [
    ["a head cut", "const a = s.slice(0, 10);\n"],
    ["a cut inside an interpolation", `const a = \`x\${s.slice(0, 10)}y\`;\n`],
    ["a cut after a line comment", "// prose\nconst a = s.slice(0, 10);\n"],
    [
      "a cut after a string that mentions one",
      'f("s.slice(0, 1)");\ns.slice(0, 10);\n',
    ],
    [
      "a cut after a regex holding a quote",
      'x.replace(/"/g, "");\ns.slice(0, 10);\n',
    ],
    [
      "a cut after a regex holding a backtick",
      "x.replace(/`+/g, '');\ns.slice(0, 10);\n",
    ],
    [
      "a cut after a regex holding both quotes",
      'x.replace(/^["\'`]+/g, "");\ns.slice(0, 10);\n',
    ],
    [
      "a cut after a divided value",
      "const r = (a + b) / 2;\ns.slice(0, 10);\n",
    ],
    [
      "a cut after an apostrophe in prose",
      "// don't do this\nconst a = s.slice(0, 10);\n",
    ],
    ["a cut after a URL in a string", 'f("https://x/y");\ns.slice(0, 10);\n'],
  ];
  for (const [name, source] of KEPT) {
    test(`${name} survives`, () => {
      expect(hits(codeOnly(source))).toBe(1);
    });
  }

  // The distinction the two exports exist for, and the reason this is not one function with a flag
  // nobody would pass: `refused-turn-callsites` matches ON a string literal, so stripping contents
  // there would blind the sweep rather than sharpen it.
  // What `codeOnly` keeps of a literal, and it is not nothing: the quotes. An emptied literal is still
  // a literal, so a pattern that requires an argument does not stop matching because the argument
  // turned out to be prose.
  test("codeOnly empties a literal without deleting it", () => {
    const call = 'f("s.slice(0, 1)");';
    expect(codeOnly(call)).toMatch(/^f\(" +"\);$/);
    expect(codeOnly(call)).toHaveLength(call.length);
    expect(codeOnly("f();")).toBe("f();");
  });

  test("withoutComments keeps a literal the pattern reads", () => {
    const source =
      '// returning "stale" would replay\nreturn refuse("stale");\n';
    expect(withoutComments(source)).toContain('refuse("stale")');
    expect(withoutComments(source)).not.toContain("would replay");
    expect(codeOnly(source)).not.toContain("stale");
  });
});

describe("the scan is positionally transparent", () => {
  // What lets a sweep strip and keep reporting WHERE it found something: `refused-turn-callsites`
  // finds its anchor in the stripped text and slices it, and `flowlog-reader-scope`-shaped readers
  // report a line number from an index.
  const source = "const a = 1; // s.slice(0, 1)\nconst b = s.slice(0, 10);\n";
  // A BLOCK comment spanning lines is what separates "blank everything" from "blank everything but
  // the newlines", and a one-line fixture cannot tell the two apart: the line count only moves when a
  // removed region had a newline in it.
  const multiline =
    "const a = 1;\n/* a cut\n   s.slice(0, 1)\n   over three lines */\nconst b = s.slice(0, 10);\n";
  test("a multi-line comment keeps its newlines", () => {
    const out = codeOnly(multiline);
    expect(out.split("\n").length).toBe(multiline.split("\n").length);
    expect(out.split("\n")[4]).toBe("const b = s.slice(0, 10);");
  });
  test("length, newlines and every kept character stay where they were", () => {
    const out = codeOnly(source);
    expect(out.length).toBe(source.length);
    expect(out.split("\n").length).toBe(source.split("\n").length);
    for (let i = 0; i < source.length; i++) {
      if (out[i] !== source[i]) expect(out[i]).toBe(" ");
    }
  });
  test("an index into the stripped text names the same line", () => {
    const at = codeOnly(source).indexOf("s.slice(0, 10)");
    expect(source.slice(0, at).split("\n").length).toBe(2);
  });
});

describe("an unterminated literal is reported rather than swallowed", () => {
  // The self-check, and it needs its own positive control: a scan that never opens anything reports
  // `null` for a healthy tree AND for a broken one.
  const OPEN: ["string" | "template" | "block-comment", string][] = [
    ["string", 'const a = "oops;\nconst b = s.slice(0, 10);\n'],
    ["template", "const a = `oops;\nconst b = 1;\n"],
    ["block-comment", "/* oops\nconst b = 1;\n"],
  ];
  for (const [expected, source] of OPEN) {
    test(`an open ${expected} is named`, () => {
      expect(unterminatedLiteral(source)).toBe(expected);
    });
  }
  // An interpolation that never closes is a THIRD way to end mid-literal, reported by a different
  // line than the two above: the template's own scan finished, and it was the code inside `${…}` that
  // ran off the end of the file.
  test("an unclosed interpolation is reported as an open template", () => {
    expect(unterminatedLiteral("const a = `x${y")).toBe("template");
  });
  test("a healthy file reports nothing", () => {
    expect(unterminatedLiteral('const a = "ok";\n')).toBeNull();
  });

  // The whole-tree assertion, and the only one that can catch the regex heuristic guessing wrong: a
  // `/` read as division opens a literal on the quote inside the regex, and that literal runs to the
  // end of the file. 601 files at the time of writing, and it costs about a second.
  test("no file under src/ ends inside a literal", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    let scanned = 0;
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
      scanned++;
      const open = unterminatedLiteral(await Bun.file(`src/${rel}`).text());
      if (open) offenders.push(`src/${rel}: ${open}`);
    }
    expect(offenders).toEqual([]);
    expect(scanned).toBeGreaterThan(500);
  });
});

// THE ONE SHAPE THE HEURISTIC GETS WRONG, MEASURED RATHER THAN REASONED ABOUT.
//
// `if (x) /re/.test(y)` puts a regex after a `)`, and a `)` ends a value, so the scan divides instead.
// Nothing in `src/` is written that way and this says so out loud: the day one is, this goes red and
// whoever wrote it learns the rule from the failure rather than from a swallowed count.
describe("the regex heuristic's known miss is not in the tree", () => {
  test("no `/` follows a closing parenthesis except to end a regex", async () => {
    const { Glob } = await import("bun");
    const suspects: string[] = [];
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
      const code = codeOnly(await Bun.file(`src/${rel}`).text());
      for (const m of code.matchAll(/\)\s*\/(?![\s/*=])/g)) {
        // A regex the scan consumed keeps its own text, so its closing `/` and flags are still there.
        // What would NOT be there is a regex the scan misread — that one opened a literal instead.
        const after = code.slice((m.index ?? 0) + 1);
        if (!/^\s*\/[gimsuyd]*[\s,;)\].]/.test(after)) {
          suspects.push(
            `src/${rel}: ${code.slice(m.index, (m.index ?? 0) + 40)}`,
          );
        }
      }
    }
    expect(suspects).toEqual([]);
  });
});

// THE FENCE, AND WHAT IT DOES NOT REACH.
//
// A sweep that walks `src/` with a Glob and counts a shape is the form that arms a false waiver: the
// ledger is per file, the phantom entry looks like every other entry, and adding it silences the file
// for good. Every one of those goes through this module, so the raw-text spelling has to be chosen on
// purpose rather than reached by copying the file next door.
//
// NOT REACHED, and the number is why this is written down instead of widened: 53 call sites in
// `tests/` read a NAMED source file as text, and most of them are doing something a strip would break
// (a migration's SQL, a handler body counted as prose and code together). `refused-turn-callsites` is
// one of those 53 and adopts the scan by judgement, not because anything here obliges it. Widening
// this to all 53 would flag dozens of readers that are correct today, which is the sweep that accuses
// everything and gets waived into silence.
describe("every Glob sweep over src/ counts through the scan", () => {
  test("and nothing reads the raw text of a globbed source file", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    const sweeps: string[] = [];
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("tests")) {
      const path = `tests/${rel}`;
      if (path === "tests/utils/source-text.ts") continue;
      // `withoutComments`, not `codeOnly`: the thing being looked for IS a string literal, and this
      // fence caught itself on that the first time it ran — `codeOnly` blanked the `"src"` it was
      // matching on and the sweep list came back empty, which reads exactly like a clean tree.
      const code = withoutComments(await Bun.file(path).text());
      if (!/\.scan\(\s*"src"/.test(code)) continue;
      // Globbing `src/` is not enough to be one of these: `agent-settings-mcp-parity` walks the same
      // tree to IMPORT each module and probe it with a Proxy, and never reads a character of source.
      // Flagging it was this fence's first result, and it is the shape a fence that accuses everything
      // takes on the way to being waived into silence.
      if (!/Bun\.file\([^)]*\)[\s\S]{0,20}\.text\(\)/.test(code)) continue;
      sweeps.push(path);
      // Either it counts through `countInSrc`, or it strips what it read itself. A sweep that imports
      // the module and does not use it on the text it globbed is the case this cannot see, and the
      // whole-file read below is what would be left to catch it.
      if (!/\bcountInSrc\b|\bcodeOnly\b|\bwithoutComments\b/.test(code)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
    // …and the fence is looking at something. Two today: this file and `write-body-required`.
    expect(sweeps.length).toBeGreaterThanOrEqual(2);
  });
});

describe("countInSrc is the shared counter", () => {
  // THE ONE THAT PROVES IT SCANS AT ALL, and it exists because the obvious assertions do not. Every
  // ledger in the tree counts the same through raw text and through the scan today — that is the
  // acceptance check this change had to pass — so a `countInSrc` quietly reading raw text breaks
  // nothing and no sweep goes red. What separates the two is a pattern that matches PROSE, and an
  // English word is the one shape guaranteed to be in the comments and absent from the code.
  test("it counts code and not the prose around it", async () => {
    const { Glob } = await import("bun");
    const RE = /\bthe\b/g;
    let raw = 0;
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
      raw += ((await Bun.file(`src/${rel}`).text()).match(RE) ?? []).length;
    }
    // 37_032 at the time of writing, so the floor is not a number this has to be kept in step with.
    expect(raw).toBeGreaterThan(10_000);
    expect(await countInSrc(RE)).toEqual({});
  });

  test("it finds a shape and reports it per file", async () => {
    const found = await countInSrc(/\bexport function opensRegex\b/g);
    // The helper lives under tests/, so a pattern naming it must come back empty from a src/ sweep.
    expect(found).toEqual({});
  });
  test("and it counts a shape that is really there", async () => {
    const found = await countInSrc(/\bexport function clipText\b/g);
    expect(found).toEqual({ "src/lib/text.ts": 1 });
  });
});
