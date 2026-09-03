import { describe, expect, test } from "bun:test";
import { codeOnly, withoutComments } from "@/tests/utils/source-text";

// A COUNTER HAS TO HAVE A SINGULAR, and the console had thirteen that did not: `audit.fields` read
// "1 campos" for a row that changed one field, and "1 fields" in English (issue #509).
//
// The cause is worth knowing before reading the rules below, because it is what makes the class
// refill itself. `i18next-parser` writes the SAME `defaultValue` into every plural category it
// generates, in every locale — so pluralizing a key produces a wrong singular, and a pt-BR catalog
// full of English, until somebody edits the file by hand. Measured while fixing #509: extracting
// after the call sites moved to `count` replaced fourteen pt-BR translations with their English
// defaults in one run. Nothing fails when that is left as it lands; it just renders.
//
// Hence a sweep rather than a note. It reads the catalogs, which is where the answer lives.
const LOCALES = {
  en: ["one", "other"],
  // CLDR gives Portuguese a `many` category as well, and the parser generates it, so a set missing
  // it is a set somebody hand-wrote and left incomplete.
  "pt-BR": ["one", "many", "other"],
} as const;

// Bases whose singular and plural are IDENTICAL ON PURPOSE, with the reason. The list is the point:
// an identical pair is either a bug or a decision, and the only way to tell them apart is for the
// decision to be written down.
const IDENTICAL_ON_PURPOSE: Record<string, string> = {
  // The count is parenthetical and no noun agrees with it: "Show all (1)".
  "credentialPicker.showAll": "parenthetical count, no noun to agree with",
  "knowledge.documentsTitleWithCount": "a heading; the count is parenthetical",
  // English has no number on the past participle: "1 selected" / "2 selected". pt-BR does, and
  // carries real forms.
  "editor.tools.mcpSelected": "en: no noun agrees with the count",
  "editor.tools.nativeActiveCount": "en: no noun agrees with the count",
};

// Keys that interpolate `{{count}}` and are still FLAT. Each one is a call site the extractor
// cannot read a literal `count` from, so adding plural forms by hand would be deleted by the next
// `bun run i18n:extract` (`keepRemoved: false`). Tracked in #513; the fix is at the call site.
const KNOWN_FLAT = new Set([
  "editor.importWarning.hoursExceptionsDropped",
  "editor.importWarning.hoursWindowsDropped",
]);

const PLURAL_SUFFIX = /^(.*)_(zero|one|two|few|many|other)$/;

// The remainder of the `t(...)` call that starts at `from` — which is just past the key literal, so
// we are already one paren deep. Balanced rather than a fixed window: a 400-character window
// swallowed neighbouring code that happens to mention `count` and waved the mutation through.
//
// The text handed in is `codeOnly`, so string bodies are already blank, and neither the parens in a
// default like "(more matched the filters)" nor the `{{count}}` in the call's own default value can
// be read as code. That second one is the whole trap: the default stays right while the options go
// wrong, which is exactly the edit this test exists to refuse.
function restOfCall(code: string, from: number): string {
  let depth = 1;
  let i = from;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  return code.slice(from, i);
}

type Catalog = Record<string, unknown>;

function flatten(node: Catalog, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    const path = `${prefix}${key}`;
    if (value && typeof value === "object") {
      Object.assign(out, flatten(value as Catalog, `${path}.`));
    } else if (typeof value === "string") {
      out[path] = value;
    }
  }
  return out;
}

async function catalog(locale: string): Promise<Record<string, string>> {
  const file = new URL(
    `../../src/client/locales/${locale}.json`,
    import.meta.url,
  );
  return flatten(JSON.parse(await Bun.file(file).text()) as Catalog);
}

describe.each(Object.entries(LOCALES))(
  "%s catalog plurals",
  (locale, forms) => {
    test("a key that interpolates a count is pluralized", async () => {
      const entries = Object.entries(await catalog(locale));
      const flatCounters = entries
        .filter(([key]) => !PLURAL_SUFFIX.test(key))
        .filter(
          ([key, value]) => value.includes("{{count}}") && !KNOWN_FLAT.has(key),
        )
        .map(([key]) => key);
      expect(flatCounters).toEqual([]);
    });

    test("every plural set carries all the categories this locale resolves", async () => {
      const entries = Object.entries(await catalog(locale));
      const sets = new Map<string, Set<string>>();
      for (const [key] of entries) {
        const m = PLURAL_SUFFIX.exec(key);
        if (!m?.[1] || !m[2]) continue;
        const found = sets.get(m[1]) ?? new Set<string>();
        found.add(m[2]);
        sets.set(m[1], found);
      }
      // A sweep that matched nothing would pass forever, and this file's whole subject is plural sets.
      expect(sets.size).toBeGreaterThan(0);
      const incomplete = [...sets.entries()]
        .filter(([, found]) => forms.some((f) => !found.has(f)))
        .map(([base]) => base);
      expect(incomplete).toEqual([]);
    });

    test("the singular differs from the plural, or says why it does not", async () => {
      const entries = await catalog(locale);
      const same: string[] = [];
      for (const [key, value] of Object.entries(entries)) {
        if (!key.endsWith("_one")) continue;
        const base = key.slice(0, -"_one".length);
        if (base in IDENTICAL_ON_PURPOSE) continue;
        if (entries[`${base}_other`] === value) same.push(base);
      }
      expect(same).toEqual([]);
    });

    // THE CATALOG BEING RIGHT IS HALF OF IT. i18next picks the plural category from `count` and from
    // nothing else, so a call site that still passes `{ n: … }` to a pluralized key renders the
    // `_other` form for every number — "1 campos" again, with both catalogs perfect. Nothing above can
    // see that, because nothing above reads the code. This does.
    test("every pluralized key is called with a count", async () => {
      const entries = await catalog(locale);
      const bases = [
        ...new Set(
          Object.keys(entries)
            .map((k) => PLURAL_SUFFIX.exec(k)?.[1])
            .filter((b): b is string => Boolean(b)),
        ),
      ];
      expect(bases.length).toBeGreaterThan(0);
      // The same inputs `i18next-parser.config.cjs` reads, because a key whose only call lives
      // outside them is a key the extractor would have deleted.
      const files = [
        ...new Bun.Glob("src/client/**/*.{ts,tsx}").scanSync("."),
        "src/modules/agents/config-health-message.ts",
      ];
      // TWO LENSES OVER THE SAME BYTES, and this globs `src/`, so it reads through
      // `tests/utils/source-text` as every sweep in this repo must. `withoutComments` keeps the
      // string literals, which is where the KEY lives; `codeOnly` blanks them, which is where the
      // `count` must NOT be found. Both blank in place rather than deleting, so one offset addresses
      // both.
      const raw = await Promise.all(files.map((f) => Bun.file(f).text()));
      const located = raw.map(withoutComments);
      const codes = raw.map(codeOnly);
      const missing: string[] = [];
      for (const base of bases) {
        const needle = `"${base}"`;
        let anyCall = false;
        for (const [file, text] of located.entries()) {
          const code = codes[file] ?? "";
          for (
            let at = text.indexOf(needle);
            at >= 0;
            at = text.indexOf(needle, at + 1)
          ) {
            anyCall = true;
            // EVERY OCCURRENCE, never "the key is fine because one call was fixed". Review found
            // that exact hole: `editor.tools.mcpSelected` is called from three places in
            // `ToolGrantsEditor`, two of them moved to `count` and the third left on `n` — so a
            // single enabled integration tool still read "1 selecionadas" while this test was green.
            if (!/\bcount\b/.test(restOfCall(code, at + needle.length))) {
              const line = text.slice(0, at).split("\n").length;
              missing.push(`${files[file]}:${line} ${base}`);
            }
          }
        }
        // Called through a variable or a template key. The extractor could not have kept the key
        // without SOME literal, so this is worth reporting rather than skipping.
        if (!anyCall) missing.push(`${base} (no literal call site)`);
      }
      expect(missing).toEqual([]);
    });

    // Portuguese resolves a `many` category (CLDR gives it to counts in the millions) and the noun
    // takes the SAME form there as in `other` — so the two differing is not a translation choice, it
    // is a form somebody never translated. That is exactly how the parser leaves a catalog: it seeds
    // every category with the English default, and whoever fixes the file by hand fixes the forms they
    // can see rendered. Measured on this branch: `knowledge.documentsTitleWithCount_many` still read
    // "Documents in {{name}} ({{count}})" next to a translated `_other`, and `knowledge.docCountPlural_many`
    // read "{{count}} documents" next to "{{count}} documentos" (issue #509).
    test.if(locale === "pt-BR")(
      "many and other carry the same form",
      async () => {
        const entries = await catalog(locale);
        const differ = Object.keys(entries)
          .filter((k) => k.endsWith("_many"))
          .filter(
            (k) =>
              entries[k] !== entries[`${k.slice(0, -"_many".length)}_other`],
          );
        expect(differ).toEqual([]);
      },
    );

    // ZERO IS PLURAL IN BRAZILIAN PORTUGUESE, and CLDR disagrees: its rule for `pt` is `one: i = 0..1`,
    // so i18next resolves a count of 0 to the SINGULAR form and the console read "0 campo". That is
    // the same defect as "1 campos" seen from the other end, and it is the one this fix introduced
    // while removing the first (measured on /audit: "0 campo" appeared the moment `audit.fields` was
    // pluralized).
    //
    // i18next answers it without touching the CLDR rules: for a count of exactly 0 it looks for
    // `<key>_zero` before asking the resolver. `i18next-parser` does not generate that form for pt —
    // there is no `zero` category to generate — but it does PRESERVE it, which is what makes this
    // usable rather than a value the next `bun run i18n:extract` deletes.
    //
    // The rule is therefore: wherever the singular and the plural differ, zero takes the plural.
    // Sets whose forms are identical on purpose need nothing, because there is no wrong answer to give.
    test.if(locale === "pt-BR")("zero takes the plural form", async () => {
      const entries = await catalog(locale);
      const wrong: string[] = [];
      for (const [key, value] of Object.entries(entries)) {
        if (!key.endsWith("_one")) continue;
        const base = key.slice(0, -"_one".length);
        const other = entries[`${base}_other`];
        if (other === undefined || other === value) continue;
        if (entries[`${base}_zero`] !== other) wrong.push(base);
      }
      expect(wrong).toEqual([]);
    });

    // The exception list is only worth anything while every entry in it still describes a real key.
    // A base renamed out from under it would leave a waiver standing over nothing, and the next
    // identical pair to arrive under that name would be waved through.
    test("every declared exception still names a plural set", async () => {
      const entries = await catalog(locale);
      const dangling = Object.keys(IDENTICAL_ON_PURPOSE).filter(
        (base) => !(`${base}_one` in entries),
      );
      expect(dangling).toEqual([]);
    });
  },
);
