import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { createTestI18n } from "@/tests/utils/i18n";

// What the reader sees. The sweep in `locale-plurals` asserts the catalogs HOLD distinct forms; this
// asserts i18next actually PICKS the singular for a count of one, through the real catalogs and the
// real plural resolver. A key can carry `_one` and `_other` and still render the plural if `count`
// is not a number: `AgentEditorPage` passes `Number(p.count ?? 0)`, so a producer sending `n`
// would put a 0 there.
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

// The parenthetical dodge ("1 window(s)"), asserted on the RENDERED sentence rather than on the
// catalog entry, in both locales.
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
    // NOTE: The count reaches the sentence: a form that dropped `{{count}}` while being pluralized would
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
