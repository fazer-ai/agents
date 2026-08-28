// The scanner every source sweep counts through, and the phantom site it exists to stop.
//
// A sweep that counts a code shape in `src/` reads the file as text, so prose that NAMES the shape is
// counted as if it were the shape. Measured on #424: a comment citing `REFUSAL_SECTIONS.slice(0, 1)`
// to explain a mutation put a file with no cut in it into the astral-cap ledger. The easy way out is
// worse than the failure it fixes — adding the entry ARMS A WAIVER over a file that has nothing to
// waive, and the day that file grows a real cut the count already matches and the sweep says nothing.
//
// It had already happened once. `tests/graph/refused-turn-callsites.test.ts` carries the same strip
// written inline, and its comment records the two phantom sites that bought it. Two sites, one
// invariant, and nothing obliging the third — so the strip lives here, and `countInSrc` exists so the
// raw-text spelling is not the convenient one.
//
// JSX TEXT IS NOT HANDLED, AND THAT IS A MEASURED DECISION RATHER THAN AN OMISSION.
//
// An earlier version of this file recognised JSX elements so their text would not be counted as code.
// It was correct about the fixture and bought nothing real: with the whole JSX mode removed, all three
// ledgers in this repo count byte-identically and the whole-tree probe below still reports zero files
// ending inside a literal. What it cost was five rounds of review — recognising an element needs a
// dry run, a memo, tag-depth balancing, closing-name matching, multi-line attribute strings — every
// one of them a mechanism justified by a hypothesis rather than by a number.
//
// So the scan removes what is unambiguous (comments, string and template bodies, regex bodies) and
// leaves `<` alone. The failure that leaves is the cheap one and it is bounded: JSX text spelling a
// swept shape would count as code, which is a phantom entry — visible, red, and fixable — rather than
// a swallowed site. Nothing in `src/` does it today; the ledgers are the check.
//
// OFFSETS AND LINE NUMBERS SURVIVE. Every removed character becomes a space and every newline is
// kept, so `source.slice(0, m.index)` still names the same position and `.split("\n").length` still
// names the same line. A sweep can strip and keep reporting where it found things.

type Scanned = {
  text: string;
  // What was still open when the file ended. A misread `/` or `<` announces itself here.
  // NOTE: there is no "jsx" here. An element is recognised by closing, so one that never closes is
  // simply not an element and the `<` stays an ordinary character — the state stopped existing when
  // that model replaced the one that decided on the opening tag.
  open: "string" | "template" | "block-comment" | null;
};

type Options = {
  // Whether the CONTENTS of string, template and JSX-text literals go too. Comments always do.
  strings: boolean;
};

// ONE FACT DECIDES BOTH AMBIGUITIES, which is why it is a variable and not two heuristics.
//
// `/` is a regex when a value cannot precede it and a division when one can; `<` opens a JSX element
// under exactly the same condition and is a comparison otherwise. Both are answered by "can the token
// just consumed END a value", tracked as the scan goes.
//
// Reading either one wrong in the permissive direction is the expensive half. An unrecognised `/"/g`
// opens a string that swallows the code after it; a `"a" / 2` read as a regex opener swallows to the
// end of the line, taking the `// comment` on it back out of view and counting it as code — the very
// failure this module exists to stop, inverted. Both were found by review on the PR that added this.
//
// The token, not the character: `"a" / 2`, `` `x` / 2 ``, `i++ / 2` and `f() / 2` all end in a value
// whose last character is not a word character.
// Every keyword after which an EXPRESSION begins, so a `/` there opens a regex and a `<` opens a JSX
// element. Missing one is not a stylistic gap: `export default <p>x</p>` was read as a comparison and
// the JSX text counted as code, which is the phantom this module exists to prevent (found by review).
const KEYWORD_BEFORE_VALUE =
  /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw|default|export|extends|as|satisfies)$/;

function scan(source: string, { strings }: Options): Scanned {
  const out = source.split("");
  let open: Scanned["open"] = null;
  // BOTH OF THESE READ `out`, NEVER `source`, AND THE BUG THAT TAUGHT IT IS THIS FILE'S OWN SUBJECT.
  // Written against the raw text, the member-access check matched the full stop ending a comment's
  // last sentence — `…(RFC 4180).` two lines above a `return /[",\n\r]/` turned that regex into a
  // division and opened a string on the quote inside it. Prose read as code, in the module whose
  // whole purpose is to stop exactly that. `out` has the comment already blanked, so it cannot.
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
    // Whether each open `{` began an OBJECT (a value) or a BLOCK. A `{` written where a value was
    // expected is an object, and the `}` that closes it therefore ends a value: `<any>{} / 2` divides,
    // while `if (x) { } …` does not. This replaces a documented gap — `}` used to read as a block
    // always, so that division opened a regex and swallowed the rest of the line together with a real
    // call site (found by review).
    const braces: boolean[] = [];
    while (i < source.length) {
      const c = source[i] as string;
      const d = source[i + 1];

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
      if (c === "/" && !endsValue) {
        // The DELIMITERS stay and the body goes, exactly like a string: `/sanitizeErrorMessage\(/` is
        // a pattern that names a call, not a call, and a sweep counting calls was counting it (found
        // by review). Skipping it is also what keeps a quote inside it from opening a string.
        let j = i + 1;
        let inClass = false;
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
            break;
          }
          j++;
        }
        if (strings) blank(i + 1, j - 1);
        i = j;
        endsValue = true;
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
        // AFTER A DOT IT IS A PROPERTY NAME, not a keyword: `obj.default / 2` divides, and reading
        // `default` as expression-opening there made the `/` a regex and hid the rest of the line
        // (found by review). `endsValue` is already true from the dot's own operand, so keeping the
        // state is exactly right.
        if (afterDot(i)) {
          endsValue = true;
          i = j;
          continue;
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
        // Whitespace is not a token, so it cannot change what the last one was. Letting it through to
        // the reset below was the first version's bug: `"a" / 2` recovered `endsValue` on the quote
        // and lost it again on the space, which is every real occurrence of the shape.
        i++;
        continue;
      }
      if (c === "!") {
        // A postfix non-null assertion leaves the value it was applied to, so `value! / 2` divides.
        // Falling through to the reset below made that `/` a regex opener (found by review).
        //
        // NOTE: no `d !== "="` guard, and a mutation run is why. In `a !== /re/` the `=` that follows
        // resets the state on its own, so excluding the comparison here changed nothing — it only
        // read as though it were load-bearing.
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
        // A `{` where a VALUE was expected is an object, EXCEPT at a statement boundary, where no
        // value was expected either because nothing precedes it. `endsValue` alone called `{}` on a
        // fresh statement an object, so the regex after it read as a division (found by review).
        braces.push(!endsValue && !atStatementStart(i));
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
  // REFUSED, not repaired, and the difference matters here. Without `g`, `String.prototype.match`
  // returns the first match plus its capture GROUPS, so `.length` is one more than the group count
  // and has nothing to do with how many times the shape occurs — a ledger built on it is wrong in a
  // direction nobody would think to check. Measured: `/\bexport function (clipText)\b/` reports 2 for
  // a file with one. Silently adding the flag would leave the caller believing a pattern that cannot
  // count is counting (found by review).
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
