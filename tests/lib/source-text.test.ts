import { describe, expect, test } from "bun:test";
import { bigIntArgs } from "@/tests/lib/caller-id-spelling.test";
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
    // A REGEX WHOSE BODY BEGINS WITH `>` IS STILL A REGEX, and this is the row that keeps the JSX
    // slash rule from eating it. `/>` closing a tag and `/>/` matching a `>` are the same two
    // characters; what separates them is that the regex CLOSES on its line and the tag does not. Both
    // spellings are in `src/`.
    ["a regex body opening with `>`", 'x.replace(/>s.slice(0, 1)/g, "");\n'],
    // THE ANCHOR OF THE URL-SCHEME RULE, PINNED BY THE COMMENT IT WOULD STOP REMOVING. The rule only
    // fires when the lookback ENDS in `http:` or `https:`; drop the `$` and a scheme name anywhere in
    // the window matches, so an ordinary comment after a label called `file` or `http` is read as a
    // URL and its prose goes back to being counted as code.
    [
      "a comment after a label spelled like a scheme",
      "switch (k) { case http: // s.slice(0, 1)\n}\n",
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
    // THE OTHER HALF OF THE `/` DECISION, and the expensive half: a division misread as a regex
    // opener swallows to the end of the line, taking a trailing comment back OUT of view and counting
    // it as code. Every one of these ends in a value whose last character is not a word character,
    // which is why the scan tracks the token and not the character. Found by review.
    [
      "a cut after a division on a string",
      'const r = "a" / 2;\nconst a = s.slice(0, 10);\n',
    ],
    [
      "a cut after a division on a template",
      "const r = `a` / 2;\nconst a = s.slice(0, 10);\n",
    ],
    [
      "a cut after a division on a call",
      "const r = f() / 2;\nconst a = s.slice(0, 10);\n",
    ],
    [
      "a cut after a division on an increment",
      "const r = i++ / 2;\nconst a = s.slice(0, 10);\n",
    ],
    // The apostrophe in ordinary JSX prose used to open a string that ran to the next quote,
    // swallowing whatever code sat in between.
    [
      "a cut after an apostrophe in JSX text",
      "<p>Don't retry</p>\nconst a = s.slice(0, 10);\n",
    ],
    [
      "a cut after an apostrophe in a JSX tag comment",
      "<b\n  // the tabs' border\n/>\nconst a = s.slice(0, 10);\n",
    ],
    // `<K extends …>(` occupies the same syntactic position as a JSX element, and TypeScript itself
    // cannot always tell them apart — hence the `<T,>` spelling. Reading one as JSX swallows the rest.
    [
      "a cut after a generic arrow",
      "const set = <K extends keyof C>(k: K) => k;\nconst a = s.slice(0, 10);\n",
    ],
    // The other spelling TypeScript accepts in a `.tsx` file, and the reason the trailing comma is a
    // signal rather than a curiosity.
    [
      "a cut after a comma-disambiguated generic",
      "const id = <T,>(x: T) => x;\nconst a = s.slice(0, 10);\n",
    ],
    // A generic carrying a STRING-LITERAL type. The first version of the generic detector refused any
    // type list holding a quote, which recognised `<div title="a > b">` correctly by accident and
    // swallowed this one.
    // THE FOUR SHAPES ONE ROUND OF REVIEW FOUND IN A DETECTOR THAT RULED GENERICS OUT FROM THE LEFT.
    // None of them closes as an element, which is the whole reason the scan now asks for a `</tag>` or
    // a `/>` instead of trying to enumerate what a type parameter list can look like.
    [
      "a cut after a generic with a structural constraint",
      "const f = <T extends { id: string }>(x: T) => x;\nconst a = s.slice(0, 10);\n",
    ],
    [
      "a cut after a plain generic arrow in a .ts file",
      "const id = <T>(x: T) => x;\nconst a = s.slice(0, 10);\n",
    ],
    [
      "a cut after a generic with a function-type constraint",
      "const g = <T extends (x: number) => string>(f: T) => f;\nconst a = s.slice(0, 10);\n",
    ],
    // …and the shape that DOES close as an element while carrying a type argument.
    // A `<` that does not close as an element is not an element, so the code after it is untouched —
    // which is the direction this model deliberately errs in.
    // A `</…>` WRITTEN IN A COMMENT does not close anything, because the closing tag has to name the
    // element that opened. Without that, `const id = <T>(x: T)` in a `.ts` file swallowed every line
    // up to a comment mentioning `</x>` — taking a real call site out of a ledger with nothing left
    // open to notice. Found by review.
    [
      "a cut before a comment naming some other closing tag",
      "const id = <T>(x: T) => x;\nconst a = s.slice(0, 10);\n// closes the </x> element\n",
    ],
    // A `{` written where a VALUE was expected is an object, so the `}` that closes it ends a value
    // and the `/` after it divides. This used to be a documented gap; the scan tracks it now.
    //
    // A `</…>` IS NOT A REGEX. Removing the JSX mode left `<` not ending a value, so the slash in a
    // closing tag opened a regex and swallowed the rest of its line — a real call site gone, with
    // nothing left open to notice. Two characters of rule, and it is what makes the removal safe:
    // what stays uncovered is JSX TEXT, which produces a phantom rather than a swallowed site.
    // Found by review.
    // WITH A LATER `/` ON THE LINE, WHICH IS WHAT MAKES A MISREAD COST ANYTHING NOW. Since a regex
    // reading that reaches the newline is backed out, a `</Foo>` read as an opener only damages the
    // line when a second slash CLOSES it — so a fixture without one measures the back-out rather than
    // the tag rule, and a mutation run showed exactly that: `closesTag` could return false for every
    // input with these rows still green.
    [
      "a cut before a division, after a JSX closing tag",
      "const x = <Foo></Foo>; const a = s.slice(0, 10); const r = b / c;\n",
    ],
    [
      "a cut after a closing tag, with a division later on the line",
      "const x = <Foo></Foo>; const a = s.slice(0, 10); const q = d / e;\n",
    ],
    [
      "a cut after a division on an object literal",
      "const ratio = <any>{} / 2;\nconst a = s.slice(0, 10);\n",
    ],
    [
      "a cut after an unclosed tag that is therefore not one",
      "f(<div class=\nconst a = s.slice(0, 10);\n",
    ],
    [
      "a cut after a JSX element with a type argument",
      'const el = <Foo<string> label="x" />;\nconst a = s.slice(0, 10);\n',
    ],
    // THE SHAPE THAT MADE THE RULE ABOVE TOO WIDE. `value < /re/` also puts a `/` after a `<`, and
    // reading it as a closing tag scans the PATTERN'S BODY as code — a quote in there opens a string
    // that eats the rest of the line, and a name in there is counted as the call it merely spells.
    // So the tag is matched as a whole shape now, not by the character before the slash. Found by
    // review, on the previous round's fix.
    // THE SELF-CLOSING TAG, WHICH THE `</Foo>` RULE DID NOT COVER. `/>` is not a regex either, and it
    // was being read as one in 135 files — blanking whatever followed it on the line, with nothing
    // left open to notice. No JSX state answers it: the regex simply never finds its closing `/`
    // before the newline, and a reading that cannot close is backed out rather than applied.
    // Written with the spread, which is the spelling that actually breaks and the one all 135 files
    // use: `<Foo />` puts an IDENTIFIER before the slash, so `endsValue` is true and the regex branch
    // is never entered — a fixture that reproduces nothing. The `}` of `{...props}` closes a block and
    // leaves no value, which is what sends the `/` down that branch.
    [
      "a cut after a self-closing tag",
      "const el = <div {...props} />; const a = s.slice(0, 10);\n",
    ],
    // The same signal, on the shape review actually reported: a `}` that closes a BLOCK leaves no
    // value, so the `/` after it opened a regex that ran to the newline and ate the call.
    [
      "a cut after a division on a function expression",
      "const r = function () {} / d; const a = s.slice(0, 10);\n",
    ],
    // A URL WRITTEN BARE IN JSX TEXT, whose `//` is not a comment. Every other position puts a URL
    // inside a string or template, which the branches above consume first; JSX text has no branch, by
    // the omission this file argues for at the top. The cut here is the real interpolation that the
    // comment reading swallowed.
    [
      "a cut in an interpolation after a URL in JSX text",
      "const el = <p>Visit https://x {s.slice(0, 10)}</p>;\n",
    ],
    // Both schemes, because `https?` is one optional character and a mutation that dropped it to
    // `https` survived on the row above alone.
    [
      "a cut in an interpolation after a plain http URL",
      "const el = <p>Visit http://x {s.slice(0, 10)}</p>;\n",
    ],
    [
      "a cut after a regex compared with `<`",
      'const r = a < /["]/.source.length; const x = s.slice(0, 10);\n',
    ],
    // ON THE SAME LINE, for the reason the DIVIDED table below spells out: a misread `/` runs to the
    // end of its own line, so a cut on the NEXT one survives either way. A mutation that dropped the
    // fragment from the tag pattern passed a next-line version of this row.
    [
      "a cut after a fragment's closing tag",
      "const x = <></>; const a = s.slice(0, 10); const r = b / c;\n",
    ],
    // The tag is matched as a WHOLE SHAPE, not by the character before the slash, so a name longer
    // than any fixed lookahead window still closes. Written long on purpose: the first fix used a
    // bounded slice, and this row is what a reintroduced bound fails on.
    [
      "a cut after a closing tag whose name is long",
      "const x = <UmNomeDeComponenteBemMaisLongoQueQualquerJanelaFixaDeLookahead></UmNomeDeComponenteBemMaisLongoQueQualquerJanelaFixaDeLookahead>; const a = s.slice(0, 10); const r = b / c;\n",
    ],
    // `else` clears `endsValue` like every keyword and leaves no terminator for the statement-start
    // check to read, so the else body was recorded as an OBJECT — and the `}` of an object ends a
    // value, turning the regex on the next line into a division that never blanks its body. Found by
    // review; the cut here is inside that regex's line, which is what the misread would expose.
    [
      "a cut after an `else` block, not an object",
      'if (x) {} else {}\n/["]/.test(y); const a = s.slice(0, 10);\n',
    ],
    // `try` and `finally` are right for a DIFFERENT reason: they are absent from
    // `KEYWORD_BEFORE_VALUE`, so they leave `endsValue` true and their braces are blocks before the
    // `else` rule is ever consulted. The row exists to hold that second path — the day one of them is
    // added to the keyword list, this is what goes red.
    [
      "a cut after a `try`/`finally` block, which never needed the rule",
      'try {} finally {}\n/["]/.test(y); const a = s.slice(0, 10);\n',
    ],
    // THE TWO HALVES OF `\belse\s*$`, EACH PINNED BY THE OBJECT IT WOULD TURN INTO A BLOCK. Both
    // mutations survived a first draft of these rows, and both fail open — they call an ordinary
    // object literal a block, so its `}` stops ending a value and the `/` after it opens a regex that
    // eats the rest of the line. That is the swallowed-call-site failure, reintroduced by the fix for
    // it.
    //
    // The fail-open direction, pinned: the rule must not reach an IDENTIFIER ending in those four
    // letters. It does not, and the `\b` is not what stops it — `orelse` ends a value, so the check is
    // short-circuited before the pattern is consulted. This row holds that ordering.
    [
      "a cut after an object held by a name ending in `else`",
      "const orelse = {} / 2; const a = s.slice(0, 10);\n",
    ],
    // Without the `$`, an `else` anywhere in the lookback window matches — including one several
    // statements above the brace being classified.
    [
      "a cut after an object literal written inside an `else` body",
      "if (x) {} else { o = {} / 2; const a = s.slice(0, 10); const r = b / c; }\n",
    ],
    // A postfix non-null assertion leaves the value it applied to, so the `/` after it divides.
    [
      "a cut after a division on a non-null assertion",
      "const r = value! / 2;\nconst a = s.slice(0, 10);\n",
    ],
    [
      "a cut after a generic with a string-literal type",
      'const f = <T extends "a" | "b",>(x: T) => x;\nconst a = s.slice(0, 10);\n',
    ],
    [
      "a cut after a multi-line type argument",
      "type A = z.infer<\n  z.ZodObject<typeof S>\n>;\nconst a = s.slice(0, 10);\n",
    ],
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
  // A REGEX BODY IS A PATTERN THAT NAMES A CALL, NOT A CALL, and it needs its own row because the
  // table above measures one spelling: a regex naming a cut writes it escaped (`\\.slice\\(`), which
  // is not what a sweep for cuts matches. The sweep it DOES fool is the one whose shape survives
  // escaping — `sanitizeErrorMessage\(` — and that is a real ledger in this repo. Found by review.
  // The other side of the object-vs-block rule, and the one a naive "`}` ends a value" would break: a
  // `{` written where a value was NOT expected is a block, so the `/` after it still opens a regex.
  test("a block's closing brace does not end a value", () => {
    // Measured through the QUOTE, not through a comment: a comment is removed either way, because
    // that branch runs before the `/` decision, so a comment-based fixture cannot tell block from
    // object. What separates them is whether the regex on the next line is READ as one, and a regex
    // holding a quote says so — as a division it opens a string and eats the rest of its line.
    const block =
      'if (x) { f(); }\n/["]/.test(y);\nsanitizeErrorMessage(err);\n';
    expect(unterminatedLiteral(block)).toBeNull();
    expect(codeOnly(block)).toContain("sanitizeErrorMessage");
  });

  test("a regex body naming a call is not a call", () => {
    // The unescaped `(` is a capture group, which is how a pattern comes to spell a call site exactly.
    const guard = /sanitizeErrorMessage\(/g;
    const source = "const re = /sanitizeErrorMessage(Deep)?/;\n";
    expect((source.match(guard) ?? []).length).toBe(1);
    expect((codeOnly(source).match(guard) ?? []).length).toBe(0);
    // …and the delimiters stay, so the regex is still a regex to anything reading structure.
    expect(codeOnly(source)).toMatch(/^const re = \/ +\/;$/m);
  });

  test("a regex body naming a column is not a column", () => {
    const column = /\b(?:lastError|errorMessage)\s*:/g;
    const source = "const re = /lastError: (.+)/;\n";
    expect((source.match(column) ?? []).length).toBe(1);
    expect((codeOnly(source).match(column) ?? []).length).toBe(0);
  });

  // What `codeOnly` keeps of a literal, and it is not nothing: the quotes. An emptied literal is still
  // a literal, so a pattern that requires an argument does not stop matching because the argument
  // turned out to be prose.
  test("codeOnly empties a literal without deleting it", () => {
    const call = 'f("s.slice(0, 1)");';
    expect(codeOnly(call)).toMatch(/^f\(" +"\);$/);
    expect(codeOnly(call)).toHaveLength(call.length);
    expect(codeOnly("f();")).toBe("f();");
  });

  // AND WITH A SECOND `/` ON IT, once the reading is a `/` decision. A regex that reaches the newline
  // is now BACKED OUT rather than applied, so a misread opener costs nothing unless a later slash
  // closes it and the text between them goes. A mutation run is what said so: with the closing-tag
  // rule returning false for every input, four rows written before the back-out stayed green, because
  // each one measured the back-out instead of the rule it was named for. The DIVIDED rows below are
  // unaffected — they turn on a quote or a comment, not on a second slash.
  //
  // ON THE SAME LINE, and that is the whole point of this table rather than the KEPT rows above. A
  // regex the scan opens by mistake runs to the end of the LINE, so a cut on the NEXT line survives
  // either way and proves nothing — a mutation run showed every "cut after a division" row passing
  // with the bug restored. What the misread actually swallows is the rest of its own line, so the
  // trailing comment is the only thing that makes it observable.
  const DIVIDED: [string, string][] = [
    ["a string", 'const r = "a" / 2; // s.slice(0, 1)\n'],
    ["a template", "const r = `a` / 2; // s.slice(0, 1)\n"],
    ["a call", "const r = f() / 2; // s.slice(0, 1)\n"],
    ["an index", "const r = a[0] / 2; // s.slice(0, 1)\n"],
    ["an increment", "const r = i++ / 2; // s.slice(0, 1)\n"],
    ["a number", "const r = 2 / 2; // s.slice(0, 1)\n"],
    ["a regex", "const r = /x/ / 2; // s.slice(0, 1)\n"],
    ["a non-null assertion", "const r = value! / 2; // s.slice(0, 1)\n"],
    ["an object literal", "const r = {} / 2; // s.slice(0, 1)\n"],
    ["a type-asserted object", "const r = <any>{} / 2; // s.slice(0, 1)\n"],
    // The `!` of `!==` is the OTHER one: an inequality is followed by a value, so a `/` after it opens
    // a regex. Treating every `!` as postfix would read that regex as a division and run on.
    [
      "nothing, after `!==` (the regex still opens)",
      'if (a !== /x"/.test(b)) f(); // s.slice(0, 1)\n',
    ],
    [
      "a less-than between identifiers",
      "if (a<b && c) f(); // s.slice(0, 1)\n",
    ],
    ["an identifier", "const r = n / 2; // s.slice(0, 1)\n"],
  ];
  for (const [what, source] of DIVIDED) {
    test(`a comment after a division on ${what} is still removed`, () => {
      expect(codeOnly(source)).not.toContain("s.slice");
    });
  }

  test("withoutComments keeps a literal the pattern reads", () => {
    const source =
      '// returning "stale" would replay\nreturn refuse("stale");\n';
    expect(withoutComments(source)).toContain('refuse("stale")');
    expect(withoutComments(source)).not.toContain("would replay");
    expect(codeOnly(source)).not.toContain("stale");
  });
});

// THE DRY RUN IS MEMOISED, AND THAT IS A CORRECTNESS PROPERTY OF THE SUITE, NOT A SPEED ONE.
//
// Recognising an element by its closing tag means probing and then replaying, and the replay probes
// again one level down — so a `<div>{cond && <div>{…}}</div>` nest doubles per level. Measured before
// the memo: 386 characters took 72 ms, and a mutation to tag depth turned the same shape into a
// mutation battery that ran nine minutes without finishing. Nothing in `src/` nests that deep today,
// which is exactly why this is pinned rather than left to be rediscovered.
describe("nested JSX does not cost exponentially", () => {
  const nest = (n: number): string =>
    n === 0 ? "<b>x</b>" : `<div>{cond && ${nest(n - 1)}}</div>`;
  test("depth 18 costs about what depth 10 does", () => {
    const time = (src: string) => {
      const t0 = Bun.nanoseconds();
      codeOnly(src);
      return (Bun.nanoseconds() - t0) / 1e6;
    };
    time(nest(10));
    // A floor of 50 ms rather than a ratio: the numbers here are fractions of a millisecond, where a
    // ratio measures scheduler noise. What this refuses is the exponential, which was 72 ms at this
    // depth and grows by 2x per level.
    expect(time(nest(18))).toBeLessThan(50);
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
  // An element that never closes is not an element, so nothing is left open and the `<` stays an
  // ordinary character. This is the model change made visible: the old scan reported an open JSX
  // state here, and the state no longer exists.
  test("an unclosed element leaves nothing open, because it is not an element", () => {
    expect(unterminatedLiteral("<div>never closed\n")).toBeNull();
    expect(codeOnly("<div>s.slice(0, 1)\n")).toContain("s.slice");
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

// THE SHAPE THE HEURISTIC STILL GETS WRONG, MEASURED RATHER THAN REASONED ABOUT.
//
// A `)` ends a value, so `if (x) /re/.test(y)` is read as a division. Telling that apart needs a real
// parser; it is absent from `src/` and this says so out loud, so the day one is written the failure
// teaches the rule instead of a count quietly changing.
//
// THE SUSPECT IS SOUGHT IN `withoutComments`, NOT IN `codeOnly`, AND THAT IS THE POINT. Review found
// the first version of this probe scanning the stripped output — where a misread `/` has ALREADY
// blanked its line, so the very shape being hunted is the one thing guaranteed not to be there. A
// probe that reads its own subject's corpse reports a clean tree no matter what. The `}` case this
// used to cover is gone from the list because the scan now tracks object-vs-block rather than
// documenting the gap.
// The predicate, extracted so it can be shown an offender. A sweep that finds nothing passes whether
// or not it is looking at anything, and this one had a sharper version of that problem: review found
// the first draft scanning `codeOnly` output, where a misread `/` has ALREADY blanked its line — so
// the very shape being hunted was the one thing guaranteed not to be there.
export function slashesAfterAParenthesis(source: string): string[] {
  // Comments out (a `)` before a `/` in prose is not code), literals kept, and crucially the scan's
  // own `/` decisions NOT applied — a probe that reads its own subject's output is reading the corpse
  // of the thing it is hunting.
  //
  // NOTE: a mutation run cannot currently tell this apart from `codeOnly`, and the note is here
  // instead of a row because that is a fact about today's tree rather than about the rule. A `/`
  // after `)` is read as a division and therefore never blanked, so both inputs agree. The case that
  // did diverge was `}`, which the scan no longer gets wrong; the ordering stays because the next
  // shape to be misread would hide from a probe written the other way.
  const code = withoutComments(source);
  const found: string[] = [];
  for (const m of code.matchAll(/\)\s*\/(?![\s/*=>])/g)) {
    // A regex the scan read correctly ends with its own `/` and flags; that is not the miss.
    const after = code.slice((m.index ?? 0) + 1);
    if (!/^\s*\/[gimsuyd]*[\s,;)\].]/.test(after)) {
      found.push(code.slice(m.index, (m.index ?? 0) + 40));
    }
  }
  return found;
}

describe("the heuristic's known miss is not in the tree", () => {
  // The control, first: the predicate sees the shape when it is there. Without this the sweep below
  // is an assertion that nothing was looked at.
  test("the predicate flags a regex written after a parenthesis", () => {
    expect(slashesAfterAParenthesis('if (x) /["]/.test(y);\n')).toHaveLength(1);
    expect(slashesAfterAParenthesis("const r = f() / 2;\n")).toEqual([]);
    // …and it is not fooled by prose, which is the whole subject of this file.
    expect(slashesAfterAParenthesis('// if (x) /["]/.test(y)\n')).toEqual([]);
  });

  test("no `/` follows a closing parenthesis except to end a regex", async () => {
    const { Glob } = await import("bun");
    const suspects: string[] = [];
    let scanned = 0;
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
      scanned++;
      for (const hit of slashesAfterAParenthesis(
        await Bun.file(`src/${rel}`).text(),
      )) {
        suspects.push(`src/${rel}: ${hit}`);
      }
    }
    expect(suspects).toEqual([]);
    expect(scanned).toBeGreaterThan(500);
  });

  // The positive control the sweep cannot give itself, and it narrows the gap rather than just
  // confirming it. A regex misread as a division is usually harmless — the scan keeps reading the
  // line as code and the comment on it is still removed, because the comment branch runs first. It
  // only does damage when the regex CARRIES A QUOTE, and that case is caught by the whole-tree probe,
  // which reports the string it leaves open.
  test("the miss is harmless unless the regex carries a quote", () => {
    const plain = "if (x) /re/.test(y); // s.slice(0, 1)\n";
    expect(codeOnly(plain)).not.toContain("s.slice");
    expect(unterminatedLiteral(plain)).toBeNull();

    // A quote inside the misread regex opens a string, which costs the REST OF THAT LINE — a string
    // stops at the newline, so the damage never reaches the next one.
    const quoted =
      'if (x) /["]/.test(y); sanitizeErrorMessage(err);\nconst a = 1;\n';
    expect(codeOnly(quoted)).not.toContain("sanitizeErrorMessage");
    expect(codeOnly(quoted)).toContain("const a = 1;");
    // …and it does not get to hide: this is what `no file under src/ ends inside a literal` reads.
    expect(unterminatedLiteral(quoted)).toBe("string");
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
      // TWO SPELLINGS, and the second is why this is a pattern rather than a string. `scan("src")`
      // puts the directory in the call; `new Glob("src/**/*.ts").scan(".")` puts it in the GLOB and
      // walks from the repo root. Review found `provider-boundary-sweep.test.ts` written the second
      // way and therefore invisible to the first draft of this fence — a fence that named one
      // spelling and reported a clean tree.
      const globsSrc =
        /\.scan\(\s*"src/.test(code) || /Glob\(\s*["'`]src\//.test(code);
      if (!globsSrc) continue;
      // Globbing `src/` is not enough to be one of these: `agent-settings-mcp-parity` walks the same
      // tree to IMPORT each module and probe it with a Proxy, and never reads a character of source.
      // Flagging it was this fence's first result, and it is the shape a fence that accuses
      // everything takes on the way to being waived into silence.
      if (!/Bun\.file\([^)]*\)[\s\S]{0,20}\.text\(\)/.test(code)) continue;
      sweeps.push(path);
      // THE IMPORT, NOT THE NAME. `refusal-callsites.test.ts` defines a LOCAL function called
      // `codeOnly` — a different thing that happens to share a word — and a name-matching fence read
      // that as adoption and let it through. A fence measures the spelling it was given, always.
      // ONE EXEMPTION, AND IT IS A PROVED ONE. `caller-id-spelling` blanks non-code itself and then
      // takes the argument's TEXT as its ledger key, so handing it stripped source rewrites the keys
      // — `BigInt(ref.slice("vault:".length))` becomes an argument full of spaces and every waiver
      // stops matching. It must read raw, and this fence would otherwise be satisfied by deleting the
      // adoption from any file. So the exemption is not a name on a list: the test below drives that
      // file's own predicate with prose and requires it to count zero.
      const provesItself = /\bblankNonCode\b/.test(code);
      if (!/from "@\/tests\/utils\/source-text"/.test(code) && !provesItself) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
    // …and the fence is looking at something. NINE today, and the count is the finding: the first
    // draft of this fence recognised one spelling of the glob and saw three of them.
    // Review named a fourth it could not see; widening it to the second spelling surfaced five more.
    // A fence that names a spelling measures the spelling, never the rule.
    expect(sweeps.length).toBeGreaterThanOrEqual(9);
  });
});

// The proof behind the one exemption above. A waiver that says "this file handles it" and is never
// exercised is the waiver this whole PR is about; this one is executed.
describe("the exempt sweep really does ignore prose", () => {
  test("caller-id-spelling counts no BigInt written in a comment", () => {
    expect(bigIntArgs("const id = BigInt(raw);\n")).toEqual(["raw"]);
    expect(bigIntArgs("// never write BigInt(raw) here\n")).toEqual([]);
    expect(bigIntArgs('const s = "BigInt(raw)";\n')).toEqual([]);
    // …and the literal inside a real argument survives, which is why it reads raw source.
    expect(
      bigIntArgs('const id = BigInt(ref.slice("vault:".length));\n'),
    ).toEqual(['ref.slice("vault:".length)']);
  });
});

describe("countInSrc is the shared counter", () => {
  // A pattern without `g` cannot count, and `String.prototype.match` does not say so: it returns the
  // first match plus its capture GROUPS, so the length is a group count wearing an occurrence count's
  // clothes. Refused rather than repaired, because silently adding the flag would leave the caller
  // believing a pattern that cannot count is counting. Found by review.
  test("it refuses a pattern that cannot count", async () => {
    expect(countInSrc(/\bexport function (clipText)\b/)).rejects.toThrow(
      /needs a \/g pattern/,
    );
  });

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
