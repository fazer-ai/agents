import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { withoutComments } from "@/tests/utils/source-text";

// A `t()` DEFAULT IS NOT THE ENGLISH TEXT. `i18next-parser` writes a default into the catalog the
// first time it sees a key and never overwrites an existing value, so editing the literal in the
// source changes nothing a user reads: the catalog answers, the default is dead code, and nothing
// fails (docs/i18n.md, "Extract DELETES keys").
//
// Measured while it happened here: the test dialog's hint was rewritten in the source to say that a
// blank `agent_name` sends the default, and en.json kept saying every blank is omitted, so the
// dialog described a payload it no longer sends.
//
// The sweep is scoped to `codeTools.*` rather than the whole console because the whole console does
// not pass: 39 of 2,687 call sites carry a default the catalog contradicts, 38 of them older than
// this file. Widening it is a separate change with a separate fix list; what it must not do is stay
// silent about the namespace being added.

const FILES = [
  "src/client/components/CodeEditor.tsx",
  "src/client/pages/resources/CodeToolEditModal.tsx",
  "src/client/pages/resources/CodeToolTestModal.tsx",
];

// `t("a.b.c", "Default"` with a string literal for both. A computed key or a default built from a
// variable is invisible here, which is the same blindness the extractor has. Comments come out and
// STRINGS STAY: `codeOnly` would strip the very literals this reads, and the sweep would then pass
// by seeing nothing, which is why the count is asserted alongside the comparison.
const CALL = /t\(\s*"(codeTools\.[\w.]+)"\s*,\s*("(?:[^"\\]|\\.)*")\s*[,)]/g;

function at(catalog: unknown, path: string): string | undefined {
  let cur: unknown = catalog;
  for (const seg of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === "string" ? cur : undefined;
}

describe("the code tool catalog says what the source says", () => {
  test("every codeTools default is the English catalog's value", async () => {
    const wrong: string[] = [];
    let seen = 0;
    for (const file of FILES) {
      const src = withoutComments(await Bun.file(file).text());
      CALL.lastIndex = 0;
      for (const m of src.matchAll(CALL)) {
        const key = m[1] as string;
        const fallback = JSON.parse(m[2] as string) as string;
        const inCatalog = at(en, key);
        // A pluralized key is stored as `<key>_one`/`_other` and has no flat entry; the plural
        // sweep in locale-plurals.test.ts is what answers for those.
        if (inCatalog === undefined) continue;
        seen += 1;
        if (inCatalog !== fallback) wrong.push(key);
      }
    }
    // If this drops to zero the sweep has stopped reading anything, which is the failure that looks
    // like success.
    expect(seen).toBeGreaterThan(15);
    // The starter body is console text the same as a label: it is the first thing an author of a
    // code tool reads, and it shipped in English until a browser showed it over a pt-BR form. It is
    // ONE line now (`starterHint` replaced `starterInput` and `starterReturn`), and it carries the
    // hotkey, so it is also the line most likely to be edited in one catalog and forgotten in the
    // other.
    expect(at(en, "codeTools.starterHint")).toBeDefined();
    expect(at(ptBR, "codeTools.starterHint")).toBeDefined();
    expect(wrong).toEqual([]);
  });

  // The other half: a key in English that pt-BR never got. `keepRemoved: false` means a missing one
  // is silently answered in English, which reads as a rendering choice rather than a gap.
  test("pt-BR carries every codeTools key English has", async () => {
    const missing: string[] = [];
    for (const file of FILES) {
      const src = withoutComments(await Bun.file(file).text());
      CALL.lastIndex = 0;
      for (const m of src.matchAll(CALL)) {
        const key = m[1] as string;
        if (at(en, key) === undefined) continue;
        if (at(ptBR, key) === undefined) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });
});
