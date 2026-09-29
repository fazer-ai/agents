import { describe, expect, test } from "bun:test";
import { bigIntArgs } from "@/tests/lib/caller-id-spelling.test";
import {
  codeOnly,
  commentSpans,
  countInSrc,
  unterminatedLiteral,
  withoutComments,
} from "@/tests/utils/source-text";

// The table for the scan every source sweep counts through, in the two directions it has to be
// right in. Reading LESS than the file is the cheap failure: a phantom site and a red CI. Reading
// MORE is the expensive one: a swallowed region is a site the sweep silently stops counting, the same
// shape as a false waiver. So every row below asserts BOTH what goes and what stays.

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
    // A KEYWORD *CAN* TOUCH A QUOTE, WHICH IS WHY THE APOSTROPHE RULE ALSO ASKS `endsValue`. This is
    // valid JavaScript that no formatter writes, so the tree cannot hold the rule and a row must: drop
    // `endsValue` from that test and the string here is read as prose, putting its contents back in
    // front of every sweep.
    ["a string glued to `return`", "function f() { return's.slice(0, 1)'; }\n"],
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
    // NOTE: THE OTHER HALF OF THE `/` DECISION, and the expensive half: a division misread as a
    // regex opener swallows to the end of the line, counting a trailing comment as code. Each of these
    // ends in a value whose last character is not a word character, which is why the scan tracks the
    // token and not the character.
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
    // NOTE: An apostrophe in ordinary JSX prose must not open a string that runs to the next quote,
    // swallowing whatever code sits in between.
    [
      "a cut after an apostrophe in JSX text",
      "<p>Don't retry</p>\nconst a = s.slice(0, 10);\n",
    ],
    // NOTE: ON THE SAME LINE, AND BETWEEN TWO OF THEM. A single apostrophe opens a string that dies
    // at the newline, so the next-line row above holds either way. A PAIR closes properly and blanks
    // the code between them silently: `unterminatedLiteral` has nothing to report.
    [
      "a cut between two apostrophes in JSX text",
      "const el = <p>Don't {s.slice(0, 10)} user's choice</p>;\n",
    ],
    // The other side of the same rule: a quote that does NOT touch a word still opens a string, which
    // is what every import specifier in the tree depends on. Without this the adjacency test would be
    // `endsValue` alone, and six files under `src/` lose theirs.
    [
      "a cut after an import specifier",
      'import { x } from "@/lib/x";\nconst a = s.slice(0, 10);\n',
    ],
    [
      "a cut after an apostrophe in a JSX tag comment",
      "<b\n  // the tabs' border\n/>\nconst a = s.slice(0, 10);\n",
    ],
    // NOTE: `<K extends …>(` occupies the same syntactic position as a JSX element, and TypeScript
    // cannot always tell them apart (hence `<T,>`). Reading one as JSX swallows the rest.
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
    // NOTE: GENERICS THAT DO NOT CLOSE AS AN ELEMENT. The scan asks for a `</tag>` or a `/>` instead
    // of enumerating what a type parameter list can look like, so none of these is read as JSX.
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
    // NOTE: a `</…>` WRITTEN IN A COMMENT closes nothing, because the closing tag has to name the
    // element that opened. Otherwise `<T>(x: T)` in a `.ts` file would swallow every line up to the
    // comment, taking a real call site out of a ledger with nothing left open to notice.
    [
      "a cut before a comment naming some other closing tag",
      "const id = <T>(x: T) => x;\nconst a = s.slice(0, 10);\n// closes the </x> element\n",
    ],
    // NOTE: a `</…>` IS NOT A REGEX: `<` does not end a value, so without the closing-tag rule its
    // slash would open a regex and swallow the rest of the line. What stays uncovered is JSX TEXT,
    // which yields a phantom rather than a swallowed site. Each row has a LATER `/` on the line: a
    // regex reading that reaches the newline is backed out, so without a second slash the row would
    // stay green with `closesTag` returning false.
    [
      "a cut before a division, after a JSX closing tag",
      "const x = <Foo></Foo>; const a = s.slice(0, 10); const r = b / c;\n",
    ],
    [
      "a cut after a closing tag, with a division later on the line",
      "const x = <Foo></Foo>; const a = s.slice(0, 10); const q = d / e;\n",
    ],
    // NOTE: a `{` written where a VALUE was expected is an object, so the `}` that closes it ends a
    // value and the `/` after it divides.
    [
      "a cut after a division on an object literal",
      "const ratio = <any>{} / 2;\nconst a = s.slice(0, 10);\n",
    ],
    // NOTE: a `<` that does not close as an element is not an element, so the code after it is
    // untouched: the direction this model deliberately errs in.
    [
      "a cut after an unclosed tag that is therefore not one",
      "f(<div class=\nconst a = s.slice(0, 10);\n",
    ],
    // NOTE: …and a shape that DOES close as an element while carrying a type argument.
    [
      "a cut after a JSX element with a type argument",
      'const el = <Foo<string> label="x" />;\nconst a = s.slice(0, 10);\n',
    ],
    // NOTE: THE SELF-CLOSING TAG. `/>` is not a regex either, and no JSX state answers it: the regex
    // never finds its closing `/` before the newline, and a reading that cannot close is backed out.
    // Written with the spread on purpose: `<Foo />` puts an IDENTIFIER before the slash, so the regex
    // branch is never entered; the `}` of `{...props}` closes a block and leaves no value, which is
    // what sends the `/` down that branch.
    [
      "a cut after a self-closing tag",
      "const el = <div {...props} />; const a = s.slice(0, 10);\n",
    ],
    // NOTE: The `}` of a function EXPRESSION ends a value, so the `/` after it divides; read as a
    // BLOCK, it would open a regex that runs to the newline and eats the call.
    [
      "a cut after a division on a function expression",
      "const r = function () {} / d; const a = s.slice(0, 10);\n",
    ],
    // NOTE: WITH A SECOND SLASH CLOSING THE LINE, since the row above passes on the back-out alone. A
    // function or class written where a VALUE was expected is an expression and its `}` closes a
    // value; read as a plain block it would open a regex that eats the cut between the two slashes.
    [
      "a cut between two divisions after a function expression",
      "const r = function () {} / d || s.slice(0, 10) / c;\n",
    ],
    [
      "a cut between two divisions after a class expression",
      "const r = class {} / d || s.slice(0, 10) / c;\n",
    ],
    // NOTE: The other side, and the reason `atStatementStart` is the whole test: a DECLARATION is not
    // a value, so the brace after it stays a block and the `/` that follows still opens a regex. The
    // regex sits right after the brace: further down the line, the identifiers before it would set
    // `endsValue` anyway and the row would pass with the rule inverted.
    [
      "a cut after a regex following a function declaration",
      'function f() {} /["]/.test(y); const a = s.slice(0, 10);\n',
    ],
    [
      "a cut after a regex following a class declaration",
      'class F {} /["]/.test(y); const a = s.slice(0, 10);\n',
    ],
    // The flag is consumed by the brace in BLOCK position, never by a destructured parameter, and it
    // does not leak into a nested declaration.
    [
      "a cut after a function expression with a destructured parameter",
      "const r = function ({ a }) {} / d || s.slice(0, 10) / c;\n",
    ],
    [
      "a cut after a function expression holding a declaration",
      "const r = function () { function g() {} } / d || s.slice(0, 10) / c;\n",
    ],
    // …and the flag is CLEARED by the brace that consumes it, so it cannot arrive at the next
    // function in the file. The declaration here would inherit the expression's body reading and its
    // `}` would start ending a value, turning the regex two tokens later into a division.
    [
      "a cut after a declaration following a function expression",
      'const r = function () {}; function g() {} /["]/.test(y); const a = s.slice(0, 10);\n',
    ],
    // NOTE: A URL WRITTEN BARE IN JSX TEXT, whose `//` is not a comment. Every other position puts a
    // URL inside a string or template, which the branches above consume first; JSX text has no
    // branch. The cut is a real interpolation that a comment reading would swallow.
    [
      "a cut in an interpolation after a URL in JSX text",
      "const el = <p>Visit https://x {s.slice(0, 10)}</p>;\n",
    ],
    // NOTE: Both schemes, because `https?` is one optional character, and narrowing it to `https`
    // passes the row above alone.
    [
      "a cut in an interpolation after a plain http URL",
      "const el = <p>Visit http://x {s.slice(0, 10)}</p>;\n",
    ],
    // NOTE: `value < /re/` also puts a `/` after a `<`; read as a closing tag, the PATTERN'S BODY
    // would be scanned as code. So the tag is matched as a whole shape, not by the preceding character.
    [
      "a cut after a regex compared with `<`",
      'const r = a < /["]/.source.length; const x = s.slice(0, 10);\n',
    ],
    // NOTE: ON THE SAME LINE, for the reason the DIVIDED table below spells out: a misread `/` runs
    // to the end of its own line, so a cut on the NEXT one survives either way.
    [
      "a cut after a fragment's closing tag",
      "const x = <></>; const a = s.slice(0, 10); const r = b / c;\n",
    ],
    // NOTE: The tag is matched as a WHOLE SHAPE, not by the character before the slash, so a name
    // longer than any fixed lookahead window still closes. Written long so a bounded slice fails it.
    [
      "a cut after a closing tag whose name is long",
      "const x = <UmNomeDeComponenteBemMaisLongoQueQualquerJanelaFixaDeLookahead></UmNomeDeComponenteBemMaisLongoQueQualquerJanelaFixaDeLookahead>; const a = s.slice(0, 10); const r = b / c;\n",
    ],
    // NOTE: `else` clears `endsValue` like every keyword and leaves no terminator for the
    // statement-start check, so without its own rule the else body reads as an OBJECT, whose `}`
    // ends a value and turns the next line's regex into a division. The cut sits on that line.
    [
      "a cut after an `else` block, not an object",
      'if (x) {} else {}\n/["]/.test(y); const a = s.slice(0, 10);\n',
    ],
    // NOTE: `try` and `finally` are right for a DIFFERENT reason: they are absent from
    // `KEYWORD_BEFORE_VALUE`, so they leave `endsValue` true and their braces are blocks before the
    // `else` rule is ever consulted. The row holds that second path: the day one of them is added to
    // the keyword list, this goes red.
    [
      "a cut after a `try`/`finally` block, which never needed the rule",
      'try {} finally {}\n/["]/.test(y); const a = s.slice(0, 10);\n',
    ],
    // NOTE: THE TWO HALVES OF `\belse\s*$`, EACH PINNED BY THE OBJECT IT WOULD TURN INTO A BLOCK.
    // Both fail open: an object read as a block stops its `}` ending a value, and the `/` after it
    // opens a regex that eats the line. Here the rule must not reach an IDENTIFIER ending in `else`,
    // and the `\b` is not what stops it: `orelse` ends a value, so the check short-circuits first.
    [
      "a cut after an object held by a name ending in `else`",
      "const orelse = {} / 2; const a = s.slice(0, 10);\n",
    ],
    // NOTE: Without the `$`, an `else` anywhere in the lookback window matches, including one several
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

  // The other side of the object-vs-block rule, and the one a naive "`}` ends a value" would break: a
  // `{` written where a value was NOT expected is a block, so the `/` after it still opens a regex.
  test("a block's closing brace does not end a value", () => {
    // Probed through a QUOTE, not a comment: comments go before the `/` decision either way.
    // A regex holding a quote tells block from object, since read as a division it opens a string
    // and eats the rest of its line.
    const block =
      'if (x) { f(); }\n/["]/.test(y);\nsanitizeErrorMessage(err);\n';
    expect(unterminatedLiteral(block)).toBeNull();
    expect(codeOnly(block)).toContain("sanitizeErrorMessage");
  });

  // NOTE: A REGEX BODY IS A PATTERN THAT NAMES A CALL, NOT A CALL. A regex naming a cut writes it escaped
  // (`\\.slice\\(`), which no sweep for cuts matches, but `sanitizeErrorMessage\(` survives escaping,
  // and a ledger in this repo sweeps for exactly that.
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

  // ON THE SAME LINE, the point of this table. A regex the scan opens by mistake runs to the end of
  // its LINE, so a cut on the NEXT line survives either way and proves nothing; the trailing comment
  // is what makes the misread observable. These rows turn on a quote or a comment, not on a second
  // slash, so backing out a regex that reaches the newline does not mask them.
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

  // NOTE: the distinction the two exports exist for, and why this is not one function with a flag nobody
  // would pass: `refused-turn-callsites` matches ON a string literal, so stripping contents there
  // would blind the sweep rather than sharpen it.
  test("withoutComments keeps a literal the pattern reads", () => {
    const source =
      '// returning "stale" would replay\nreturn refuse("stale");\n';
    expect(withoutComments(source)).toContain('refuse("stale")');
    expect(withoutComments(source)).not.toContain("would replay");
    expect(codeOnly(source)).not.toContain("stale");
  });
});

// THE DRY RUN IS MEMOISED, A CORRECTNESS PROPERTY OF THE SUITE, NOT A SPEED ONE. Recognising an
// element by its closing tag means probing and then replaying, and the replay probes again one level
// down, so without the memo a `<div>{cond && <div>{…}}</div>` nest doubles per level and a mutation
// battery never finishes. Nothing in `src/` nests that deep, which is why this is pinned.
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
    // NOTE: a floor of 50 ms rather than a ratio: these numbers are fractions of a millisecond, where
    // a ratio measures scheduler noise. The exponential doubles per level and clears the floor here.
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

describe("the same scan says where the comments were", () => {
  const spans = (src: string) =>
    commentSpans(src).map(([a, b]) => src.slice(a, b));

  test("a span is exactly the comment, with no trailing whitespace", () => {
    // The caller that cares is the one slicing the span to read it: an untrimmed span ends in the
    // indentation of the line BELOW, so `endsWith("*/")` stops being true of a block comment.
    expect(spans("const a = 1; // aside\nconst b = 2;\n")).toEqual([
      "// aside",
    ]);
    expect(spans("<div>\n  {/* label */}\n  <X />\n</div>\n")).toEqual([
      "/* label */",
    ]);
  });

  test("comments separated by nothing but whitespace come back as one span", () => {
    // Which is what a reader means by "the comment", and the reason a per-LINE question (a
    // `biome-ignore`, honoured only at the start of its own comment) is asked of the line.
    expect(spans("// one\n// two\nconst a = 1;\n")).toEqual(["// one\n// two"]);
    // …and code between them splits them again.
    expect(spans("// one\nconst a = 1;\n// two\n")).toEqual([
      "// one",
      "// two",
    ]);
  });

  test("a comment spelled inside a literal is not one", () => {
    expect(spans('const s = "// not a comment";\n')).toEqual([]);
    expect(spans('const s = "{/* NOTE: nor this */}";\n')).toEqual([]);
  });

  test("a comment that runs to the end of the file still closes", () => {
    expect(spans("const a = 1;\n// trailing")).toEqual(["// trailing"]);
    expect(spans("const a = 1;\n/* unterminated")).toEqual(["/* unterminated"]);
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
  // NOTE: an element that never closes is not an element, so nothing is left open and the `<` stays an
  // ordinary character: the scan has no JSX state to leave open.
  test("an unclosed element leaves nothing open, because it is not an element", () => {
    expect(unterminatedLiteral("<div>never closed\n")).toBeNull();
    expect(codeOnly("<div>s.slice(0, 1)\n")).toContain("s.slice");
  });

  test("a healthy file reports nothing", () => {
    expect(unterminatedLiteral('const a = "ok";\n')).toBeNull();
  });

  // NOTE: the whole-tree assertion, and the only one that can catch the regex heuristic guessing wrong: a
  // `/` read as division opens a literal on the quote inside the regex, and that literal runs to the
  // end of the file. It costs about a second.
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

// THE SHAPE THE HEURISTIC STILL GETS WRONG. A `)` ends a value, so `if (x) /re/.test(y)` is read as
// a division; telling it apart needs a real parser. It is absent from `src/`, and this predicate says
// so out loud, so the day one is written the failure teaches the rule instead of a count changing.
// Extracted so it can be shown an offender. The suspect is sought in `withoutComments`, NOT in
// `codeOnly`, where a misread `/` has ALREADY blanked its line and the shape could never be found.
export function slashesAfterAParenthesis(source: string): string[] {
  // Comments out (a `)` before a `/` in prose is not code), literals kept, and the scan's own
  // `/` decisions NOT applied. Today `codeOnly` gives the same answer (a `/` after `)` is read as a
  // division and never blanked), but the next shape to be misread would hide from it.
  const code = withoutComments(source);
  const found: string[] = [];
  // NOTE: WHITESPACE AFTER THE SLASH IS NOT AN EXCLUSION: a regex body may begin with a space, so
  // `if (x) / sanitizeErrorMessage/` is the miss too, read by the scan as a division with a phantom
  // call.
  for (const m of code.matchAll(/\)\s*\/(?![/*=>])/g)) {
    const at = m.index ?? 0;
    // Only a reading that CLOSES on its line can cost anything: one that reaches the newline
    // is backed out by the scan. This asks only "is there another slash", not the scan's regex walk:
    // honouring `[/]` or `\/` can only find FEWER slashes, and the two differ only on an unterminated
    // regex containing `[/`, which is not valid source.
    const slash = code.indexOf("/", at);
    const eol = code.indexOf("\n", slash);
    if (!code.slice(slash + 1, eol === -1 ? code.length : eol).includes("/")) {
      continue;
    }
    // A regex the scan read correctly ends with its own `/` and flags, AGAINST the `)`
    // (`/foo(bar)/g`), so no whitespace is allowed before it: `) / ` would read as a regex end with
    // zero flags and hide the case above.
    const after = code.slice(at + 1);
    if (!/^\/[gimsuyd]*[\s,;)\].]/.test(after)) {
      found.push(code.slice(at, at + 40));
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

  // NOTE: a regex body may open with a space, so whitespace after the slash is no proof of a division.
  test("the predicate flags a regex whose body opens with a space", () => {
    expect(
      slashesAfterAParenthesis(
        "if (x) / sanitizeErrorMessage(Deep)?/.test(y);\n",
      ),
    ).toHaveLength(1);
  });

  // NOTE: a reading that never closes on its line is backed out by the scan and costs nothing, so it is not
  // a suspect. This keeps the predicate from reporting every division in the tree.
  test("the predicate ignores a slash that closes nothing on its line", () => {
    expect(slashesAfterAParenthesis("const r = (a + b) / 2;\n")).toEqual([]);
    expect(
      slashesAfterAParenthesis("const x = f(a) / b;\nconst y = 1;\n"),
    ).toEqual([]);
  });

  // NOTE: AND THE FALSE POSITIVE IT ACCEPTS, PINNED SO IT IS NOT A SURPRISE. Two divisions on one line are
  // indistinguishable from a regex with spaces in it without a real parser, the very miss this probe
  // documents, so it reports the shape and a person reads it. Nothing in `src/` writes it, so the
  // sweep below can still require zero.
  test("the predicate also flags two divisions sharing a line", () => {
    expect(
      slashesAfterAParenthesis("const r = (a + b) / 2 + c / d;\n"),
    ).toHaveLength(1);
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

  // NOTE: the positive control the sweep cannot give itself. A regex misread as a division is usually
  // harmless: the line stays code and its comment is still removed, because the comment branch runs
  // first. It only does damage when the regex CARRIES A QUOTE, and the whole-tree probe catches that
  // by reporting the string it leaves open.
  test("the miss is harmless unless the regex carries a quote", () => {
    const plain = "if (x) /re/.test(y); // s.slice(0, 1)\n";
    expect(codeOnly(plain)).not.toContain("s.slice");
    expect(unterminatedLiteral(plain)).toBeNull();

    // A quote inside the misread regex opens a string, which costs the REST OF THAT LINE: a
    // string stops at the newline, so the damage never reaches the next one.
    const quoted =
      'if (x) /["]/.test(y); sanitizeErrorMessage(err);\nconst a = 1;\n';
    expect(codeOnly(quoted)).not.toContain("sanitizeErrorMessage");
    expect(codeOnly(quoted)).toContain("const a = 1;");
    // …and it does not get to hide: this is what `no file under src/ ends inside a literal` reads.
    expect(unterminatedLiteral(quoted)).toBe("string");
  });
});

// THE FENCE, AND WHAT IT DOES NOT REACH. A sweep that globs `src/` and counts a shape arms a false
// waiver (the ledger is per file and a phantom entry looks like any other), so each one goes through
// this module and a raw-text read is chosen on purpose. NOT REACHED: tests that read a NAMED source
// file as text, most of which do something a strip would break (a migration's SQL, a handler body);
// flagging them would accuse correct readers and get the fence waived into silence.
describe("every Glob sweep over src/ counts through the scan", () => {
  test("and nothing reads the raw text of a globbed source file", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    const sweeps: string[] = [];
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("tests")) {
      const path = `tests/${rel}`;
      if (path === "tests/utils/source-text.ts") continue;
      // `withoutComments`, not `codeOnly`: the thing looked for IS a string literal, and
      // `codeOnly` would blank the `"src"` being matched, returning an empty sweep list that reads
      // exactly like a clean tree.
      const code = withoutComments(await Bun.file(path).text());
      // TWO SPELLINGS, hence a pattern: `scan("src")` puts the directory in the call;
      // `new Glob("src/**/*.ts").scan(".")` puts it in the GLOB and walks from the repo root, as
      // `provider-boundary-sweep.test.ts` does.
      const globsSrc =
        /\.scan\(\s*"src/.test(code) || /Glob\(\s*["'`]src\//.test(code);
      if (!globsSrc) continue;
      // NOTE: Globbing `src/` is not enough: `agent-settings-mcp-parity` walks the tree to IMPORT
      // each module and probe it with a Proxy, never reading source, and flagging it would make this
      // a fence that accuses everything.
      if (!/Bun\.file\([^)]*\)[\s\S]{0,20}\.text\(\)/.test(code)) continue;
      sweeps.push(path);
      // THE IMPORT, NOT THE NAME: `refusal-callsites.test.ts` defines a LOCAL `codeOnly`,
      // which a name match would read as adoption. ONE EXEMPTION, a proved one: `caller-id-spelling`
      // blanks non-code itself and keys its ledger on the argument's TEXT, so stripped source would
      // rewrite its keys. The exemption is not a name on a list: the test below drives that file's
      // own predicate with prose and requires it to count zero.
      const provesItself = /\bblankNonCode\b/.test(code);
      if (!/from "@\/tests\/utils\/source-text"/.test(code) && !provesItself) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
    // NOTE: …and the fence is looking at something: a fence that names a spelling measures the
    // spelling, never the rule, so a floor on the sweeps found catches one that stops matching.
    expect(sweeps.length).toBeGreaterThanOrEqual(9);
  });
});

// The proof behind the one exemption above: a waiver that says "this file handles it" is executed
// here, not taken on trust.
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
  // NOTE: a pattern without `g` cannot count, and `String.prototype.match` does not say so: it returns the
  // first match plus its capture GROUPS, so the length is a group count wearing an occurrence count's
  // clothes. Refused rather than repaired, because silently adding the flag would leave the caller
  // believing a pattern that cannot count is counting.
  test("it refuses a pattern that cannot count", async () => {
    expect(countInSrc(/\bexport function (clipText)\b/)).rejects.toThrow(
      /needs a \/g pattern/,
    );
  });

  // NOTE: THE ONE THAT PROVES IT SCANS AT ALL. Every ledger in the tree counts the same through raw text
  // and through the scan, so a `countInSrc` quietly reading raw text turns no sweep red. What
  // separates the two is a pattern that matches PROSE, and an English word is the one shape
  // guaranteed to be in the comments and absent from the code.
  test("it counts code and not the prose around it", async () => {
    const { Glob } = await import("bun");
    const RE = /\bthe\b/g;
    let raw = 0;
    for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
      raw += ((await Bun.file(`src/${rel}`).text()).match(RE) ?? []).length;
    }
    // NOTE: a loose floor, so it never has to be kept in step with the tree.
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
