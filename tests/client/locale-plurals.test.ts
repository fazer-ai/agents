import { describe, expect, test } from "bun:test";
import { codeOnly, withoutComments } from "@/tests/utils/source-text";

// A counter has to have a singular: "1 campos" / "1 fields" for one changed field is wrong. The class
// refills itself: `i18next-parser` writes the SAME `defaultValue` into every plural category it
// generates, in every locale, so pluralizing a key produces a wrong singular and English in the
// pt-BR catalog until someone edits the file by hand, and nothing fails. Hence a sweep over the
// catalogs, where the answer lives.
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

// Keys that interpolate `{{count}}` and are still FLAT. Each one would be a call site the extractor
// cannot read a literal `count` from, so plural forms added by hand would be deleted by the next
// `bun run i18n:extract` (`keepRemoved: false`): the fix is always at the call site, never in the
// catalog. Empty; keep it that way.
const KNOWN_FLAT = new Set<string>([]);

// The parenthetical dodge: "1 window(s)", "1 janela(s)". Grammatical for both numbers and
// machine-sounding for both; the same defect as a missing singular, seen from the catalog. It also
// catches a counted string whose variable is not `count` (`{{n}}`), which the sweep above cannot.
// The lookbehind keeps `http(s)` (two schemes, never a plural) out without a per-key waiver, which
// would make the sweep edition-DEPENDENT: a key absent from the Free catalog would dangle there.
const PARENTHETICAL_PLURAL =
  /(?<=\w)(?<!\bhttp)\((s|es|is|as|os|ns|ões|ãos)\)/i;

// Strings where the parentheses are a decision rather than a dodge, with the reason. Only strings
// the regex above cannot rule out on its own belong here.
const DODGE_WAIVED: Record<string, string> = {
  // Two INDEPENDENT counts in one sentence, and i18next pluralizes a key on exactly one
  // `count`, so the fix is two keys (a change to the sentence, not the catalog). English carries no
  // defect here, since its adjectives do not inflect.
  "channels.synced": "two independent counts in one key; needs splitting",
};

const PLURAL_SUFFIX = /^(.*)_(zero|one|two|few|many|other)$/;

// The base of a key, plural suffix removed. A waiver names the base, so it covers every form of the
// same string rather than needing one line per category.
function stripPlural(key: string): string {
  return PLURAL_SUFFIX.exec(key)?.[1] ?? key;
}

// The remainder of the `t(...)` call that starts at `from`, just past the key literal, so already one
// paren deep. Balanced rather than a fixed window, which would swallow neighbouring code that
// mentions `count`. The text is `codeOnly`, so string bodies are blank: neither parens in a default
// nor the `{{count}}` in the call's own default can be read as code (the default can stay right
// while the options go wrong).
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

// A waiver is a standing exemption, so it must still name a string that actually dodges. The check
// is CROSS-CATALOG on purpose: `channels.synced` dodges only in pt-BR, so a per-locale check needs a
// tolerance, and the one that fits ("the key still exists") would keep a waiver whose string was
// FIXED. Over every catalog, one hit anywhere is enough and zero everywhere means the waiver is spent.
test("every declared dodge waiver still names a string that dodges somewhere", async () => {
  const all = await Promise.all(Object.keys(LOCALES).map(catalog));
  const spent = Object.keys(DODGE_WAIVED).filter(
    (key) =>
      !all.some((entries) =>
        Object.entries(entries).some(
          ([k, v]) => stripPlural(k) === key && PARENTHETICAL_PLURAL.test(v),
        ),
      ),
  );
  expect(spent).toEqual([]);
});

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

    // NOTE: a base cannot be both flat and pluralized. While ONE call site of a key still passes
    // `{ n: … }`, `i18next-parser` keeps the flat key next to the plural set, and the next extract
    // deletes it, turning CI's generated-file check red. The rule above cannot see it, since the
    // leftover interpolates `{{n}}` rather than `{{count}}`.
    test("no base is both flat and pluralized", async () => {
      const entries = await catalog(locale);
      const pluralized = new Set(
        Object.keys(entries)
          .map((k) => PLURAL_SUFFIX.exec(k)?.[1])
          .filter((b): b is string => Boolean(b)),
      );
      const both = Object.keys(entries).filter((k) => pluralized.has(k));
      expect(both).toEqual([]);
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

    // NOTE: the catalog being right is half of it. i18next picks the plural category from `count`
    // and from nothing else, so a call site still passing `{ n: … }` to a pluralized key renders
    // `_other` for every number, with both catalogs perfect. This reads the code.
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
      // Two lenses over the same bytes, read through `tests/utils/source-text` as every sweep
      // over `src/` must. `withoutComments` keeps the string literals (where the KEY lives);
      // `codeOnly` blanks them (where `count` must NOT be found). Both blank in place, so one offset
      // addresses both.
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
            // NOTE: EVERY OCCURRENCE, never "the key is fine because one call was fixed": a key
            // called from three places with one left on `n` still renders "1 selecionadas".
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

    // NOTE: Portuguese resolves a `many` category (counts in the millions) and the noun takes the
    // SAME form there as in `other`, so the two differing is a form somebody never translated. The
    // parser seeds every category with the English default, and a hand fix covers only the forms
    // that are seen rendered.
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

    // NOTE: zero is plural in Brazilian Portuguese, and CLDR disagrees: its `pt` rule is
    // `one: i = 0..1`, so i18next would render "0 campo". For a count of exactly 0 i18next looks for
    // `<key>_zero` first; `i18next-parser` does not generate it for pt but PRESERVES it, so the next
    // extract keeps it. Wherever the singular and plural differ, zero takes the plural; sets
    // identical on purpose need nothing.
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

    test("no counter fakes its plural with a parenthesis", async () => {
      const entries = await catalog(locale);
      const dodging = Object.entries(entries)
        .filter(([key]) => !(stripPlural(key) in DODGE_WAIVED))
        .filter(([, value]) => PARENTHETICAL_PLURAL.test(value))
        .map(([key]) => key);
      expect(dodging.sort()).toEqual([]);
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
