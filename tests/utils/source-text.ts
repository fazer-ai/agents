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
// THAT LAST SENTENCE WAS TOO STRONG ONCE, AND REVIEW CAUGHT IT. JSX text is the one position where a
// URL can be written bare, and its `//` was read as a comment — a SWALLOW, not a phantom, taking a
// real interpolation with it. `http` and `https` are answered now (see `URL_SCHEME`); a bare
// `ws://x` in JSX prose is still a swallow, counted at zero and written down rather than claimed
// away. The bound holds for everything else JSX text can spell.
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

// `else` is the one keyword whose `{` opens a BLOCK and that still reaches this check. It clears
// `endsValue` like every expression-introducing keyword, and it leaves no terminator for
// `atStatementStart` to read, so `if (x) {} else {}` recorded the else body as an OBJECT — and an
// object's `}` ends a value, turning the regex on the next line into a division that never blanks its
// body (found by review).
//
// THE LIST IS ONE WORD BECAUSE THE OTHER CANDIDATES ARE UNMEASURABLE, NOT BECAUSE THEY WERE
// FORGOTTEN. A first draft read `else|try|finally|do`; a mutation run then removed `try|finally|do`
// without turning a single test red. `try` and `finally` are absent from `KEYWORD_BEFORE_VALUE`, so
// they leave `endsValue` true and the `&&` below short-circuits before ever asking this — dead
// alternatives, indistinguishable from a typo. `do` does clear `endsValue`, but its body's `}` is
// always followed by `while (…)`, so the misclassification has nowhere to surface. Adding either back
// would be a rule no test could hold.
//
// NOTE: A MUTATION RUN CANNOT REMOVE THE `\b`, AND THE NOTE IS HERE INSTEAD OF A ROW. Reaching this
// check at all requires `endsValue` to be false, and any identifier ending in those four letters —
// `orelse` — sets it true and short-circuits. So the only token that can both reach here and match is
// the keyword, and `\b` is saying what the regex means rather than deciding anything. It stays for
// that reason, not because a test holds it.
const KEYWORD_BEFORE_BLOCK = /\belse\s*$/;
// Enough to clear `else` plus the whitespace before the brace.
const KEYWORD_LOOKBACK = 16;

// The scheme whose `//` is part of a URL rather than the start of a comment. See the branch that
// reads it: only JSX text can carry one bare, because every other position is inside a literal.
//
// TWO NARROWER SPELLINGS WERE TRIED AND BOTH WERE REMOVED BY A MUTATION RUN WITHOUT TURNING A TEST
// RED. `\b(?:https?|wss?|ftps?|file)` claimed five more schemes and a token boundary; nothing reaches
// either, because the only position where this branch can fire is bare JSX text and there is no
// `ws://` written as visible prose in `src/`. What survives is what a person actually types where a
// reader will see it.
//
// A bare `ws://x` in JSX text would still be read as a comment and swallow its line. THAT RESIDUE IS
// COUNTED, NOT ASSUMED: `src/` holds five non-http `scheme://` today, every one inside a `//`
// comment, where the leading slashes are consumed first and these are never examined; none is in a
// `.tsx` file at all. No probe guards it, and that is deliberate — every version of one reads a
// corpse. The swallow happens in the COMMENT branch, so by the time a sweep sees the text the `//`
// is already blanked, and a raw-text probe cannot tell JSX prose from a websocket URL in a string.
//
// The `$` is NOT decoration and has its own row: without it, `case file: // …` matches inside the
// lookback window and the comment stops being removed.
const URL_SCHEME = /https?:$/;

// A closing JSX tag or fragment, anchored with the sticky flag so no arbitrary lookahead window has
// to bound the component name. `lastIndex` is assigned on every call, so nothing leaks between scans.
//
// WHAT IS STILL AMBIGUOUS, AND WHAT CLOSES IT. `a</b>/` is a comparison against the regex `/b>/`, and
// it is indistinguishable from a closing tag without a real parser — the scan calls it a tag and
// blanks nothing. It needs the `<` GLUED to the `/`, which is a spelling the formatter does not
// produce: `bun format` rewrites that line to `a < /b>/`, where the space breaks the adjacency and
// the regex is read correctly. So the residue is held out of the tree by `bun check`, not by luck,
// and the formatted spelling has its own row in the decision table.
const CLOSING_TAG = /<\/\s*(?:[A-Za-z_$][\w$.:-]*\s*)?>/y;

function closesTag(source: string, at: number): boolean {
  CLOSING_TAG.lastIndex = at;
  return CLOSING_TAG.test(source);
}

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

      // A `//` THAT CLOSES A URL SCHEME IS NOT A COMMENT, and JSX text is where one can be written
      // bare. `<p>Visit https://x {value.slice(0, 1)}</p>` blanked from the `//` to the end of the
      // line — taking a real interpolation with it, silently, since a comment leaves nothing open.
      // Everywhere else a URL is already inside a string or template, whose branch consumes it before
      // this one is reached; JSX text has no such branch, by the deliberate omission at the top of
      // this file. Found by review.
      //
      // The scheme is spelled out rather than matched as `[a-z][a-z0-9+.-]*:`, because that pattern
      // also covers `case x: //` and a label, where the `//` IS a comment. These are the schemes that
      // are followed by `//`; a bare `custom://` in JSX text would still be misread, and the probe
      // below pins that none is written.
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
      // A `/` right after a `<` closes a JSX tag; it never opens a regex. Removing the JSX mode left
      // `<` not ending a value, so `</Foo>` entered the regex branch and swallowed the rest of its
      // line — including a real call site, with nothing left open to notice (found by review).
      //
      // Matched as the WHOLE closing tag rather than by the single character before it, because
      // `value < /sanitizeErrorMessage/` puts a letter after that `/` too, and reading it as a tag
      // scans the pattern's body as code — inventing the call the sweep then counts (found by
      // review, on the fix above).
      if (c === "/" && !endsValue && closesTag(source, i - 1)) {
        i++;
        continue;
      }
      if (c === "/" && !endsValue) {
        // The DELIMITERS stay and the body goes, exactly like a string: `/sanitizeErrorMessage\(/` is
        // a pattern that names a call, not a call, and a sweep counting calls was counting it (found
        // by review). Skipping it is also what keeps a quote inside it from opening a string.
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
        // A REGEX LITERAL CANNOT SPAN A NEWLINE, SO ONE THAT REACHES IT WAS NEVER A REGEX — back the
        // reading out instead of blanking to the end of the line. Review found the blanking version
        // erasing a real call site in `function () {} / d && sanitizeErrorMessage(err)` with nothing
        // left open to notice, and asked for the miss to be REPORTED; reporting turned out to be the
        // smaller half of the answer, because the same signal identifies the misread.
        //
        // It is the whole disambiguator for the JSX slash, and it needs no JSX state: `/>` at the end
        // of a tag never finds its closing `/` on that line, while `.replace(/>/g, "&gt;")` — a real
        // regex whose body is `>` — closes two characters later. Both are in `src/`; the first is in
        // 135 files and was being read as a regex, silently swallowing whatever followed it on the
        // line. `</Foo>` is answered earlier, by shape; this answers the other half.
        //
        // Backing out errs toward the PHANTOM and away from the swallow, which is the direction this
        // whole module is built to err in: an unterminated regex in genuinely invalid source now shows
        // its body as code, which a ledger reports loudly, rather than eating the line in silence.
        //
        // NOTE: `endsValue = false` HERE IS UNOBSERVABLE, and the note is here instead of a row. It
        // says what a division operator means — a value is expected after it — but for the flag to
        // change anything the next token would have to be another `/`, and a `/` that reaches this
        // line has already scanned forward looking for exactly that. If one were there the regex
        // would have CLOSED on it and never reached the back-out. A row written for it measured
        // something else: in `{} / /re/` the first slash closes on the second.
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
      // A QUOTE THAT DIRECTLY FOLLOWS A VALUE IS NOT A QUOTE, and this is the third ambiguity the one
      // fact settles. `identifier'x'` is not TypeScript — a string literal never touches the token
      // before it — so a `'` sitting against a word is an apostrophe in JSX prose. `<p>Don't
      // {sanitizeErrorMessage(err)} user's choice</p>` opened a string at the first one and closed it
      // at the second, blanking the real call in between and leaving nothing open to notice. An
      // earlier row covered only the SINGLE apostrophe, whose string dies at the newline and so costs
      // one line; the pair is the silent case. Found by review.
      //
      // TWO CONDITIONS, AND THE SECOND IS NOT REDUNDANT. `endsValue` survives whitespace by design —
      // that was itself a fix on this PR — so it alone also rejects the string in `import x from "y"`,
      // where `from` is an ordinary identifier. What separates the two is ADJACENCY: prose writes
      // `Don't` with the quote against the word, and code always writes a space. Measured, not
      // reasoned: without the adjacency test six files under `src/` lose their import specifiers.
      //
      // The keywords that CAN touch a quote (`case'x'`, `return'x'`) are the ones that clear
      // `endsValue`, so they are already on the other side of this test and open their string.
      //
      // WHAT ADJACENCY DOES NOT REACH, WRITTEN DOWN RATHER THAN IMPLIED. A quote SEPARATED from the
      // word — `<p>He said "hi {…} bye" now</p>` — still opens a string. Dropping the adjacency test
      // would cover it, and then the only collisions left are the contextual keywords that are not in
      // `KEYWORD_BEFORE_VALUE`: `from` and `import`, which precede a string with a space in every
      // import in the tree. That is a list this repo cannot test, since nothing in `src/` writes a
      // spaced quote in JSX prose — so the rule stops where the measurement stops. The whole-tree
      // probe is what would catch it going wrong: the first draft of this test, without adjacency,
      // reported six files ending inside a string.
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
        braces.push(
          !endsValue &&
            !atStatementStart(i) &&
            !KEYWORD_BEFORE_BLOCK.test(before(i, KEYWORD_LOOKBACK)),
        );
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
