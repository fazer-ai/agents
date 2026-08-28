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
// OFFSETS AND LINE NUMBERS SURVIVE. Every removed character becomes a space and every newline is
// kept, so `source.slice(0, m.index)` still names the same position and `.split("\n").length` still
// names the same line. A sweep can strip and keep reporting where it found things.

type Scanned = {
  text: string;
  // What was still open when the file ended. A misread regex announces itself here.
  open: "string" | "template" | "block-comment" | null;
};

type Options = {
  // Whether the CONTENTS of string and template literals go too. Comments always do.
  strings: boolean;
};

// Where a `/` opens a regex literal rather than dividing. Shape alone cannot tell the two apart, and
// erring toward division is the expensive half: an unrecognised `/"/g` opens a string that swallows
// the code after it, and swallowed code is a site the sweep stops counting without a word. `src/`
// carries a dozen such regexes today (`/^["'`]+|["'`]+$/g` in `graph/nudge.ts`, `/[\\']/g` in the
// Drive toolpack, `/"/g` in four more), so this branch is load-bearing rather than defensive.
//
// The rule is the standard one: a `/` divides only when what precedes it can END a value. Anything
// else — an operator, a comma, an opening bracket, `return`, `typeof`, the start of the file — opens a
// regex. The known miss is `if (x) /re/.test(y)`, where `)` closes a condition rather than a value;
// the test beside this file pins that `src/` has none.
const KEYWORD_BEFORE_REGEX =
  /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;
// Enough to clear the widest indentation in the tree; a `/` further than this from the token before it
// would have to sit under 64 columns of blank, which the formatter does not produce.
const LOOKBEHIND = 64;

function opensRegex(source: string, at: number): boolean {
  const before = source
    .slice(Math.max(0, at - LOOKBEHIND), at)
    .replace(/\s+$/, "");
  if (before === "") return true;
  if (KEYWORD_BEFORE_REGEX.test(before)) return true;
  // An identifier, a number or a closing bracket ends a value, so a `/` after one divides. This also
  // answers `this`, `true` and `null` without naming them: they end in a letter, so the test below
  // already calls them values. A mutation run proved the explicit list they had was dead code.
  return !/[A-Za-z0-9_$)\]]/.test(before[before.length - 1] as string);
}

function scan(source: string, { strings }: Options): Scanned {
  const out = source.split("");
  let open: Scanned["open"] = null;
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };

  // Consumes code from `from`. With `stopAtBrace` it is inside a `${…}` and returns the index of the
  // `}` that closes it, counting the braces opened in between so an object literal does not end it
  // early; otherwise it runs to the end of the file.
  function code(from: number, stopAtBrace: boolean): number {
    let i = from;
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
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
      if (c === "/" && opensRegex(source, i)) {
        // Consumed and never blanked: a regex is code. Skipping it is exactly what keeps the quotes
        // inside it from being read as the start of a string.
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
        i = j;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < source.length && source[j] !== c && source[j] !== "\n") {
          j += source[j] === "\\" ? 2 : 1;
        }
        if (j >= source.length || source[j] === "\n") open = "string";
        // The quotes themselves stay, so an emptied literal is still a literal: a sweep can tell
        // `f("")` from `f()`, and a pattern that requires an argument does not stop matching because
        // the argument was prose. (Not for the sake of a pattern that READS the literal — that is
        // `withoutComments`, which blanks nothing.)
        if (strings) blank(i + 1, j);
        i = j + 1;
        continue;
      }
      if (c === "`") {
        i = template(i + 1);
        continue;
      }
      if (stopAtBrace) {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return i;
          depth--;
        }
      }
      i++;
    }
    // NOTE: an unclosed `${…}` needs no flag here — reaching the end returns to `template`, which is
    // where the open template is recorded. A mutation run proved a second one dead.
    return i;
  }

  // Consumes from just past an opening backtick and returns the index just past the closing one. The
  // literal runs are blanked; every `${…}` goes back through `code`, because an interpolation holds
  // real code and a cut written in one is a real cut.
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
        i = code(i + 2, true) + 1;
        start = i;
        continue;
      }
      i++;
    }
    if (strings) blank(start, source.length);
    open = "template";
    return source.length;
  }

  code(0, false);
  return { text: out.join(""), open };
}

// Comments out, string contents kept. For a sweep whose pattern READS a literal: the refusal spelling
// `refuse("stale")`, an error key, a route path.
export function withoutComments(source: string): string {
  return scan(source, { strings: false }).text;
}

// Comments out AND string contents out. For a sweep counting a code SHAPE, where a literal spelling
// that shape is prose by another name.
export function codeOnly(source: string): string {
  return scan(source, { strings: true }).text;
}

// What the scan still had open when the file ended, or `null`. This is the self-check a misread regex
// trips: it opens a literal that never closes and swallows every site after it. Cheap enough to assert
// over the whole tree, and the only check available that does not need a second parser to agree with.
export function unterminatedLiteral(source: string): Scanned["open"] {
  return scan(source, { strings: true }).open;
}

// The one way a sweep counts a shape across `src/`, so that the raw-text spelling has to be written on
// purpose rather than reached by copying the file next door.
export async function countInSrc(re: RegExp): Promise<Record<string, number>> {
  const { Glob } = await import("bun");
  const found: Record<string, number> = {};
  for await (const rel of new Glob("**/*.{ts,tsx}").scan("src")) {
    const n = (codeOnly(await Bun.file(`src/${rel}`).text()).match(re) ?? [])
      .length;
    if (n > 0) found[`src/${rel}`] = n;
  }
  return found;
}
