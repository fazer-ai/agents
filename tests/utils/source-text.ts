// The scanner every source sweep counts through. A sweep that counts a code shape reads the file as
// text, so prose that NAMES the shape counts as the shape (a PHANTOM site), and a ledger entry for it
// arms a waiver over a file with nothing to waive; `countInSrc` makes the stripped spelling the easy
// one. It removes what is unambiguous (comments, string, template and regex bodies) and does not
// parse JSX text: a swept shape in JSX text is a phantom (visible, fixable), while a spaced quote or
// a non-HTTP `scheme://` in visible text still SWALLOWS what follows (`URL_SCHEME` answers `http` and
// `https`). OFFSETS AND LINE NUMBERS SURVIVE: every removed character becomes a space and every
// newline is kept, so a sweep can strip and still report where it found things.

type Scanned = {
  text: string;
  // What was still open when the file ended. A misread `/` or `<` announces itself here.
  // NOTE: there is no "jsx" state: an element is recognised by closing, so one that never closes is
  // not an element and its `<` stays an ordinary character.
  open: "string" | "template" | "block-comment" | null;
};

type Options = {
  // Whether the CONTENTS of string, template and JSX-text literals go too. Comments always do.
  strings: boolean;
};

// ONE FACT DECIDES BOTH AMBIGUITIES: can the token just consumed END a value. `/` is a regex when it
// cannot and a division when it can; `<` opens a JSX element under the same condition. Misreading
// either permissively is the expensive half: an unrecognised `/"/g` opens a string that swallows the
// code after it, and `"a" / 2` read as a regex swallows the line's `// comment` into code. The token,
// not the character: `"a" / 2`, `` `x` / 2 ``, `i++ / 2` and `f() / 2` all end a value. Below: every
// keyword after which an EXPRESSION begins; a missing one (`export default <p>x</p>`) counts JSX
// text as code.
const KEYWORD_BEFORE_VALUE =
  /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw|default|export|extends|as|satisfies)$/;

// `else` is the one keyword whose `{` opens a BLOCK and still reaches this check: it clears
// `endsValue` and leaves no terminator for `atStatementStart`, so without this `if (x) {} else {}`
// records the else body as an OBJECT, whose `}` turns a regex on the next line into a division.
// `try`, `finally` and `do` are left out because no test can hold them: `try`/`finally` never clear
// `endsValue`, and a `do` body's `}` is always followed by `while (…)`. The `\b` decides nothing
// (only the keyword can reach here and match) and stays for what it says.
const KEYWORD_BEFORE_BLOCK = /\belse\s*$/;
// The two keywords whose body is a VALUE when they are written as an expression. `function` and
// `class` are the whole list: an arrow's body already lands on the object side of the brace rule and
// so already ends a value, and no other construct puts a block where a value belongs.
const FUNCTION_OR_CLASS = /^(?:function|class)$/;
// Enough to clear `else` plus the whitespace before the brace.
const KEYWORD_LOOKBACK = 16;

// The scheme whose `//` is part of a URL rather than a comment. Only JSX text can carry one bare,
// since every other position is inside a literal, and only `http`/`https` are written as visible
// prose in `src/`. A bare `ws://x` in JSX text is still read as a comment and swallows its line; no
// probe can guard it, since the comment branch blanks the `//` before a sweep sees the text. The `$`
// has its own row: without it, `case file: // …` matches in the lookback window and the comment
// stops being removed.
const URL_SCHEME = /https?:$/;

// A closing JSX tag or fragment, anchored with the sticky flag so no lookahead window bounds the
// component name; `lastIndex` is assigned on every call. Still ambiguous: `a</b>/` (a comparison
// against the regex `/b>/`) reads as a tag without a real parser, but only with the `<` GLUED to the
// `/`, which `bun format` rewrites to `a < /b>/`. So `bun check` keeps that residue out of the tree,
// and the formatted spelling has its own row in the decision table.
const CLOSING_TAG = /<\/\s*(?:[A-Za-z_$][\w$.:-]*\s*)?>/y;

function closesTag(source: string, at: number): boolean {
  CLOSING_TAG.lastIndex = at;
  return CLOSING_TAG.test(source);
}

function scan(source: string, { strings }: Options): Scanned {
  const out = source.split("");
  let open: Scanned["open"] = null;
  // BOTH OF THESE READ `out`, NEVER `source`: on raw text the member-access check would match
  // the full stop ending a comment's sentence (`…(RFC 4180).` above a `return /[",\n\r]/` turns that
  // regex into a division), reading prose as code. `out` has the comment already blanked.
  const before = (at: number, n: number) =>
    out.slice(Math.max(0, at - n), at).join("");
  // Whether the token just before `at` is a `.`, making what follows a property name rather than a
  // keyword: `obj.default / 2` divides.
  const afterDot = (at: number) => /\.\s*$/.test(before(at, 8));
  // Whether nothing but a statement terminator precedes `at`, making a `{` there a block.
  const atStatementStart = (at: number) => {
    const b = before(at, 64).replace(/\s+$/, "");
    return b === "" || b.endsWith(";") || b.endsWith("}");
  };
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };

  // From an opening quote; returns the index just past the closing one.
  function quoted(from: number): number {
    const q = source[from];
    let j = from + 1;
    while (j < source.length && source[j] !== q && source[j] !== "\n") {
      j += source[j] === "\\" ? 2 : 1;
    }
    if (j >= source.length || source[j] === "\n") open = "string";
    // The quotes themselves stay, so an emptied literal is still a literal: a sweep can tell `f("")`
    // from `f()`, and a pattern that requires an argument does not stop matching because the argument
    // was prose.
    if (strings) blank(from + 1, j);
    return j + 1;
  }

  // From just past an opening backtick; returns the index just past the closing one. Literal runs are
  // blanked and every `${…}` goes back through `code`, because an interpolation holds real code and a
  // cut written in one is a real cut.
  function template(from: number): number {
    let i = from;
    let start = i;
    while (i < source.length) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        if (strings) blank(start, i);
        return i + 1;
      }
      if (c === "$" && source[i + 1] === "{") {
        if (strings) blank(start, i);
        i = code(i + 2, "brace") + 1;
        start = i;
        continue;
      }
      i++;
    }
    if (strings) blank(start, source.length);
    open = "template";
    return source.length;
  }

  // Consumes code from `from`. With `stop === "brace"` it is inside a `${…}` or a JSX `{…}` and
  // returns the index of the `}` that closes it, counting the braces opened in between so an object
  // literal does not end it early; otherwise it runs to the end of the file.
  function code(from: number, stop: "brace" | "eof"): number {
    let i = from;
    let depth = 0;
    let endsValue = false;
    // Whether each open `{` began an OBJECT (a value) or a BLOCK. A `{` where a value was
    // expected is an object, and its `}` ends a value: `<any>{} / 2` divides, while `if (x) { } …` does
    // not. Reading every `}` as a block would open a regex on that division and swallow the line.
    const braces: boolean[] = [];
    // Set when a `function` or `class` keyword is read in a value position, cleared by the brace that
    // opens its body. See both sites below.
    let expressionBody = false;
    while (i < source.length) {
      const c = source[i] as string;
      const d = source[i + 1];

      // NOTE: A `//` THAT CLOSES A URL SCHEME IS NOT A COMMENT, and JSX text is where one can be written
      // bare: blanking from the `//` in `<p>Visit https://x {value.slice(0, 1)}</p>` would silently take
      // the real interpolation with it. Everywhere else a URL is inside a string or template, consumed
      // before this branch. The scheme is spelled out rather than matched as `[a-z][a-z0-9+.-]*:`, which
      // also covers `case x: //` and a label, where the `//` IS a comment; a bare `custom://` in JSX text
      // is still misread, and the probe below pins that none is written.
      if (c === "/" && d === "/" && URL_SCHEME.test(before(i, 8))) {
        i += 2;
        continue;
      }
      if (c === "/" && d === "/") {
        const nl = source.indexOf("\n", i);
        const to = nl === -1 ? source.length : nl;
        blank(i, to);
        i = to;
        continue;
      }
      if (c === "/" && d === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end === -1) open = "block-comment";
        const to = end === -1 ? source.length : end + 2;
        blank(i, to);
        i = to;
        continue;
      }
      // NOTE: A `/` right after a `<` closes a JSX tag and never opens a regex, or `</Foo>` would swallow
      // the rest of its line, call sites included. Matched as the WHOLE closing tag rather than by the
      // character before it: `value < /sanitizeErrorMessage/` also puts a letter after that `/`, and
      // reading it as a tag scans the pattern's body as code, inventing the call the sweep then counts.
      if (c === "/" && !endsValue && closesTag(source, i - 1)) {
        i++;
        continue;
      }
      if (c === "/" && !endsValue) {
        // The DELIMITERS stay and the body goes, exactly like a string: `/sanitizeErrorMessage\(/` is
        // a pattern that names a call, not a call. Skipping it also keeps a quote inside it from opening a
        // string.
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < source.length) {
          const r = source[j];
          if (r === "\\") {
            j += 2;
            continue;
          }
          if (r === "\n") break;
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) {
            j++;
            closed = true;
            break;
          }
          j++;
        }
        // NOTE: A REGEX LITERAL CANNOT SPAN A NEWLINE, SO ONE THAT REACHES IT WAS NEVER A REGEX: back the
        // reading out rather than blank to the end of the line, which would erase the call in
        // `function () {} / d && sanitizeErrorMessage(err)`. This alone disambiguates the JSX slash: `/>`
        // ending a tag never finds a closing `/` on its line, while `.replace(/>/g, "&gt;")` closes two
        // characters later. Backing out errs toward the PHANTOM, away from the swallow. `endsValue = false`
        // here is unobservable (a following `/` would have closed the regex); it states what a division means.
        if (!closed) {
          i++;
          endsValue = false;
          continue;
        }
        if (strings) blank(i + 1, j - 1);
        i = j;
        endsValue = true;
        continue;
      }
      // NOTE: A QUOTE THAT DIRECTLY FOLLOWS A VALUE IS NOT A QUOTE: a string literal never touches the
      // token before it, so a `'` against a word is an apostrophe in JSX prose, and a pair of them
      // (`Don't {call(err)} user's`) would blank the call between. Two conditions: `endsValue` survives
      // whitespace, so alone it would also reject `import x from "y"` (`from` is an identifier), and
      // ADJACENCY separates them, since code always writes a space. `case'x'` and `return'x'` clear
      // `endsValue` and open their string. Not reached: a quote SEPARATED from the word in JSX prose still
      // opens a string, and covering it needs a keyword list (`from`, `import`) nothing in `src/` tests.
      if ((c === '"' || c === "'") && endsValue && /[\w$]/.test(before(i, 1))) {
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        i = quoted(i);
        endsValue = true;
        continue;
      }
      if (c === "`") {
        i = template(i + 1);
        endsValue = true;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < source.length && /[A-Za-z0-9_$]/.test(source[j] as string))
          j++;
        // NOTE: AFTER A DOT IT IS A PROPERTY NAME, not a keyword: `obj.default / 2` divides, and reading
        // `default` as expression-opening would make the `/` a regex and hide the rest of the line.
        // `endsValue` is already true from the dot's own operand, so keeping the state is exactly right.
        if (afterDot(i)) {
          endsValue = true;
          i = j;
          continue;
        }
        // NOTE: A FUNCTION OR CLASS WRITTEN WHERE A VALUE WAS EXPECTED IS AN EXPRESSION, and its `}` closes
        // a VALUE: `const r = function () {} / d` divides. The brace cannot tell (the token before it is the
        // parameter list's `)` either way, as in `if (x) {`), so it is recorded here at the keyword and
        // consumed by that brace. `!atStatementStart` is the whole test: nothing valid puts a value before
        // these keywords, so `!endsValue` would reject only `if (x) function f() {}`, which is not valid.
        if (
          FUNCTION_OR_CLASS.test(source.slice(i, j)) &&
          !atStatementStart(i)
        ) {
          expressionBody = true;
        }
        // A keyword cannot end a value, and that is what lets `return /re/` and `case "x"` through.
        endsValue = !KEYWORD_BEFORE_VALUE.test(source.slice(i, j));
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        while (
          i < source.length &&
          /[0-9.eExXa-fA-F_]/.test(source[i] as string)
        )
          i++;
        endsValue = true;
        continue;
      }
      if (c === " " || c === "\n" || c === "\t" || c === "\r") {
        // NOTE: Whitespace is not a token, so it cannot change what the last one was: through the reset
        // below, `"a" / 2` would lose `endsValue` on the space, which is every real occurrence of the shape.
        i++;
        continue;
      }
      if (c === "!") {
        // NOTE: A postfix non-null assertion leaves the value it was applied to, so `value! / 2` divides
        // (the reset below would make that `/` a regex opener). No `d !== "="` guard: in `a !== /re/` the
        // following `=` resets the state on its own.
        i++;
        continue;
      }
      if ((c === "+" || c === "-") && d === c) {
        // `i++ / 2`: the increment leaves the value it was applied to, so the `/` still divides.
        i += 2;
        continue;
      }
      if (c === "{") {
        if (stop === "brace") depth++;
        // A `{` where a VALUE was expected is an object, EXCEPT at a statement boundary, where nothing
        // precedes it (otherwise `{}` on a fresh statement is an object and the regex after it a division).
        // The pending flag is consumed by the first brace in BLOCK position, and CLEARED there so it
        // cannot arrive at the next function in the file. A destructured parameter cannot eat it:
        // `function ({ a }) {}` pushes that first `{` where a value was expected, so it is an object
        // and the body is still to come.
        const block =
          endsValue ||
          atStatementStart(i) ||
          KEYWORD_BEFORE_BLOCK.test(before(i, KEYWORD_LOOKBACK));
        braces.push(!block || expressionBody);
        if (block) expressionBody = false;
        endsValue = false;
        i++;
        continue;
      }
      if (c === "}") {
        if (stop === "brace") {
          if (depth === 0) return i;
          depth--;
        }
        endsValue = braces.pop() ?? false;
        i++;
        continue;
      }
      endsValue = c === ")" || c === "]";
      i++;
    }
    return i;
  }

  code(0, "eof");
  return { text: out.join(""), open };
}

// Comments out, string contents kept. For a sweep whose pattern READS a literal: the refusal spelling
// `refuse("stale")`, an error key, a route path.
export function withoutComments(source: string): string {
  return scan(source, { strings: false }).text;
}

// Comments out AND literal contents out. For a sweep counting a code SHAPE, where a literal spelling
// that shape is prose by another name.
export function codeOnly(source: string): string {
  return scan(source, { strings: true }).text;
}

// WHERE THE COMMENTS WERE: the same scan read from the other side, so nothing here has to know what a
// comment looks like a second time. `withoutComments` blanks every comment to spaces and keeps the
// offsets, so a run of blanks the source did not spell IS a comment, and a `//` inside a string stays
// unblanked and is therefore not one. Comments separated by nothing but whitespace MERGE into one
// span, which is what a reader means by "the comment"; so a caller asking about a per-LINE shape (a
// `biome-ignore`, honoured only at the start of its own comment) has to look at the line. Two JSX
// comments never merge: the `}` and `{` between them are code.
export function commentSpans(source: string): Array<[number, number]> {
  const blanked = withoutComments(source);
  const spans: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= source.length; i++) {
    const removed =
      i < source.length && blanked[i] === " " && source[i] !== " ";
    if (start < 0) {
      if (removed) start = i;
      continue;
    }
    // Inside a span, a blank in the BLANKED text continues it. The comment's own spaces and newlines
    // survive the blanking untouched, so requiring a difference at every position would cut a
    // comment into one span per word.
    if (i < source.length && (blanked[i] === " " || blanked[i] === "\n"))
      continue;
    let end = i;
    while (end > start && /\s/.test(source[end - 1] as string)) end--;
    spans.push([start, end]);
    start = removed ? i : -1;
  }
  return spans;
}

// What the scan still had open when the file ended, or `null`. This is the self-check a misread `/` or
// `<` trips: it opens a literal that never closes and swallows every site after it. Cheap enough to
// assert over the whole tree, and the only check available that does not need a second parser to
// agree with.
export function unterminatedLiteral(source: string): Scanned["open"] {
  return scan(source, { strings: true }).open;
}

// The one way a sweep counts a shape across `src/`, so that the raw-text spelling has to be written on
// purpose rather than reached by copying the file next door.
export async function countInSrc(re: RegExp): Promise<Record<string, number>> {
  // NOTE: REFUSED, not repaired. Without `g`, `String.prototype.match` returns the first match plus
  // its capture GROUPS, so `.length` is one more than the group count and unrelated to how many times
  // the shape occurs: `/\bexport function (clipText)\b/` reports 2 for a file with one. Silently
  // adding the flag would leave the caller believing a pattern that cannot count is counting.
  if (!re.flags.includes("g")) {
    throw new Error(
      `countInSrc needs a /g pattern to count occurrences; ${re} would report a capture-group count instead.`,
    );
  }
  const { Glob } = await import("bun");
  const found: Record<string, number> = {};
  for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
    const n = (codeOnly(await Bun.file(`src/${rel}`).text()).match(re) ?? [])
      .length;
    if (n > 0) found[`src/${rel}`] = n;
  }
  return found;
}

// A SECOND, SIMPLER SCRUBBER, here rather than in a `.test.ts`: a test file another imports registers
// its tests again in the importer's shard, so shard totals stop matching the serial run
// (tests/lib/source-text.test.ts still imports `bigIntArgs` from caller-id-spelling.test.ts, whose
// waiver ledger is keyed by file). NOT merged into `codeOnly`, which answers regex bodies and URL
// schemes for callers counting positions; these count braces. Blanks every comment and string body
// to spaces, offsets preserved: counting braces on raw text drifts SILENTLY, since comments here are
// full of `{ error }`, `{{placeholder}}` and `${…}`, and one stray brace shifts every block after it.
export function codeSkeleton(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end < 0 ? src.length : end + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i] as string;
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === "\\") k += 2;
        else if (src[k] === quote) break;
        else k++;
      }
      blank(i + 1, k);
      i = k + 1;
    } else i++;
  }
  return out.join("");
}
