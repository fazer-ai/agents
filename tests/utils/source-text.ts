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
  // A JSX element is recognised by CLOSING, not by opening (see `jsx`), so the scan has to be able to
  // try one and take it back. While `applying` is false nothing is written and nothing is reported.
  let applying = true;
  // The dry run is memoised by start index, and that is not an optimisation. Without it the cost is
  // exponential in the JSX/`{…}` alternation depth, because each level probes and then replays, and
  // the replay probes again: measured on a synthetic nest, 386 characters took 72 ms and each further
  // level doubled it. A mutation that broke tag depth turned the same shape into a battery that ran
  // for nine minutes without finishing, which is how this was found. Safe because the answer depends
  // only on the index and the source, and the source never changes.
  const elementEnd = new Map<number, number | null>();
  const blank = (from: number, to: number) => {
    if (!applying) return;
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

  // From the `<` of an opening element; returns the index just past it, or `null` when what follows is
  // not a well-formed element.
  //
  // RECOGNISED BY CLOSING, NOT BY OPENING, and that is what replaced a detector that tried to rule out
  // generics from the left. Ruling out is unbounded — review found four separate shapes it got wrong
  // in one round (`<Foo<string> …/>`, `<T extends { id: string }>(`, `<_Foo>`, and plain `<T>(x: T)` in
  // a `.ts` file) — while requiring a `</tag>` or `/>` answers all of them at once and needs no list:
  // a type parameter list simply never closes as an element. The failure it leaves is the cheap one
  // (JSX text counted as code) instead of the expensive one (the rest of the file swallowed).
  //
  // JSX TEXT IS A LITERAL and nothing else here would treat it as one: `<p>s.slice(0, 1)</p>` is a
  // phantom cut to every sweep, and the apostrophe in `<p>Don't retry</p>` opens a string that runs on.
  function jsx(from: number): number | null {
    if (!applying) {
      const seen = elementEnd.get(from);
      if (seen !== undefined) return seen;
    }
    const end = scanElement(from);
    if (!applying) elementEnd.set(from, end);
    return end;
  }

  function scanElement(from: number): number | null {
    let i = from + 1;
    if (!/[A-Za-z_$>]/.test(source[i] ?? "")) return null;
    let selfClosing = false;
    // The tag. `<` and `>` are balanced so a type argument (`<Foo<string> …/>`) does not end it early;
    // attribute values are literals, `{…}` in one is code. Starts at 1: the `<` this was entered on
    // counts, and starting at 0 made the closing `>` of a plain `<Foo>` read as one too many.
    let depth = 1;
    while (i < source.length) {
      const c = source[i];
      if (c === "/" && source[i + 1] === "/") {
        const nl = source.indexOf("\n", i);
        const to = nl === -1 ? source.length : nl;
        blank(i, to);
        i = to;
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        const to = end === -1 ? source.length : end + 2;
        blank(i, to);
        i = to;
        continue;
      }
      if (c === '"' || c === "'") {
        i = quoted(i);
        continue;
      }
      if (c === "{") {
        i = code(i + 1, "brace") + 1;
        continue;
      }
      if (c === "<") {
        depth++;
        i++;
        continue;
      }
      if (c === "/" && source[i + 1] === ">" && depth === 1) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (c === ">") {
        depth--;
        i++;
        if (depth === 0) break;
        continue;
      }
      i++;
    }
    // NOTE: no `if (!closed) return null` here. The tag loop only exits without closing by running out
    // of source, and the children loop below then finds no `</` and returns null anyway — a mutation
    // run showed the explicit check could not be made to matter.
    if (selfClosing) return i;
    // The children.
    let start = i;
    while (i < source.length) {
      const c = source[i];
      if (c === "{") {
        if (strings) blank(start, i);
        i = code(i + 1, "brace") + 1;
        start = i;
        continue;
      }
      if (c === "<") {
        if (strings) blank(start, i);
        if (source[i + 1] === "/") {
          const gt = source.indexOf(">", i);
          return gt === -1 ? null : gt + 1;
        }
        const child = jsx(i);
        // A child that is not an element makes the parent not one either. Both this and the `null` on
        // a missing `>` below survive the mutation battery: the only inputs that reach them are
        // syntactically invalid source, where every variant is already harmless. Kept as the
        // conservative answer rather than deleted, and the gap is written down rather than implied.
        if (child === null) return null;
        i = child;
        start = i;
        continue;
      }
      i++;
    }
    return null;
  }

  // Consumes code from `from`. With `stop === "brace"` it is inside a `${…}` or a JSX `{…}` and
  // returns the index of the `}` that closes it, counting the braces opened in between so an object
  // literal does not end it early; otherwise it runs to the end of the file.
  function code(from: number, stop: "brace" | "eof"): number {
    let i = from;
    let depth = 0;
    let endsValue = false;
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
      if (c === "<" && !endsValue && /[A-Za-z_$>]/.test(d ?? "")) {
        // Tried without writing anything, then replayed for real. The dry run is what lets the scan
        // recognise an element by its closing tag without having to undo a half-consumed one.
        const wasApplying = applying;
        const wasOpen = open;
        applying = false;
        const end = jsx(i);
        applying = wasApplying;
        open = wasOpen;
        if (end !== null) {
          jsx(i);
          i = end;
          endsValue = true;
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < source.length && /[A-Za-z0-9_$]/.test(source[j] as string))
          j++;
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
      if (stop === "brace") {
        if (c === "{") depth++;
        else if (c === "}") {
          if (depth === 0) return i;
          depth--;
        }
      }
      // NOTE: `}` reads as the end of a BLOCK, never of an object literal, so `({}) / 2` is misread
      // as a regex. Telling the two apart needs a real parser, and a block is the overwhelmingly
      // common case; the whole-tree probe beside this file is what says the tree has no instance.
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
