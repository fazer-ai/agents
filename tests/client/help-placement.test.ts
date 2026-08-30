import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";

// The rule in docs/ui.md → "Where help goes", as a check rather than a paragraph somebody has to
// remember. It is here because the failure mode it guards is not a bug: a 500-character hint
// renders correctly, passes every other test, and only shows up as a page that reads like prose
// with inputs embedded in it (issue #411).
//
// What it actually enforces is the SORTING, not the prose. A hint that grows past a sentence has
// stopped being what the operator needs to fill the field and started being what they need to
// decide whether the field applies to them, which is the other outcome and has its own home.

const HINT_MAX = 200;

// The SOURCE language only, which is the rule as docs/ui.md states it. Enforcing the same number
// on pt-BR looks stricter and is a different rule: pt-BR runs about 6% longer, so a compliant
// English hint whose natural translation crosses the line would fail CI, and the only way to make
// it pass is to move the field's help somewhere else. That makes translation length decide UI
// placement, which is exactly what the per-key-in-the-source rule exists to prevent.
//
// pt-BR is not left unguarded: it is a translation of a source that had to pass, and the paragraph
// check below runs on both.
const SOURCE = { en } as Record<string, unknown>;
const LOCALES = { en, "pt-BR": ptBR } as Record<string, unknown>;

function flatten(node: unknown, prefix = ""): [string, string][] {
  if (typeof node === "string") return [[prefix, node]];
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  );
}

// A key is inline text by its suffix. `Help` is the popover and is deliberately unbounded here:
// it has its own shape check below.
const INLINE = /(Hint|Note|Explain)$/;

describe("where help goes (docs/ui.md)", () => {
  test("inline field text stays a sentence", () => {
    const over: string[] = [];
    for (const [locale, cat] of Object.entries(SOURCE)) {
      for (const [key, value] of flatten(cat)) {
        if (!INLINE.test(key)) continue;
        if (value.length <= HINT_MAX) continue;
        over.push(`${locale} ${key} (${value.length})`);
      }
    }
    // Named in the failure rather than counted, because the fix is per key: re-run the three tests
    // in docs/ui.md on that field and move the text to the outcome it actually belongs to.
    expect(over).toEqual([]);
  });

  // The `?` is not a licence for the wall of prose it just took off the page. Three short
  // paragraphs (what it is, what it does, the caveat) is the shape, and `Popover` renders a
  // blank-line-separated string as exactly that.
  test("popover help keeps its three-paragraph shape", () => {
    const bad: string[] = [];
    for (const [locale, cat] of Object.entries(LOCALES)) {
      for (const [key, value] of flatten(cat)) {
        if (!key.endsWith("Help")) continue;
        const paragraphs = value.split(/\n\s*\n/).filter((p) => p.trim());
        if (paragraphs.length > 3) {
          bad.push(`${locale} ${key}: ${paragraphs.length} paragraphs`);
        }
        const longest = Math.max(...paragraphs.map((p) => p.length));
        if (longest > 300)
          bad.push(`${locale} ${key}: paragraph of ${longest}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
