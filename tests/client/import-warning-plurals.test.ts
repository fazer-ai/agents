import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { createTestI18n } from "@/tests/utils/i18n";

// WHAT THE READER SEES, which is the thing issue #513 was about. The sweep in `locale-plurals`
// asserts the catalogs HOLD distinct forms; this asserts i18next actually PICKS the singular for a
// count of one, through the real catalogs and the real plural resolver.
//
// The two are not the same assertion, and the gap between them is where this defect lived: a key
// can carry `_one` and `_other` and still render the plural for every count, if the `count` handed
// in is not a number. `AgentEditorPage` passes `Number(p.count ?? 0)` for exactly that reason, and a
// producer that renames the field back to `n` puts a 0 there, which reads as the plural in a
// sentence about one document.
const KEYS = [
  "editor.importWarning.hoursWindowsDropped",
  "editor.importWarning.hoursExceptionsDropped",
  "editor.importWarning.kbReusedDocsSkipped",
  "editor.importWarning.unknownGrantSourceSkipped",
];

const RESOURCES = {
  en: { translation: en },
  "pt-BR": { translation: ptBR },
};

// The parenthetical dodge, asserted on the RENDERED sentence rather than on the catalog entry:
// "1 window(s)" is what all four of these used to read, in both locales.
const PARENTHETICAL_PLURAL =
  /(?<=\w)(?<!\bhttp)\((s|es|is|as|os|ns|ões|ãos)\)/i;

describe.each(["en", "pt-BR"])("import warnings read as %s", (lng: string) => {
  const t = createTestI18n(lng, RESOURCES).getFixedT(lng);

  test.each(KEYS)("%s has a singular a reader would write", (key: string) => {
    const one = t(key, { name: "X", count: 1 });
    const two = t(key, { name: "X", count: 2 });
    expect(one).not.toBe(key);
    expect(one).not.toBe(two);
    expect(one).not.toMatch(PARENTHETICAL_PLURAL);
    expect(two).not.toMatch(PARENTHETICAL_PLURAL);
    // The count reaches the sentence: a form that dropped `{{count}}` while being pluralized would
    // otherwise pass every check above.
    expect(one).toContain("1");
    expect(two).toContain("2");
  });

  // A count of zero is a sentence somebody reads too, and it takes the plural (the `_zero` form the
  // catalog sweep requires of pt-BR). Never the singular, which would read "0 janela semanal".
  test.each(KEYS)("%s reads zero as a plural", (key: string) => {
    const zero = t(key, { name: "X", count: 0 });
    const two = t(key, { name: "X", count: 2 });
    expect(zero).toBe(two.replace("2", "0"));
  });
});
