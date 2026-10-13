import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { importWarningMessage } from "@/client/lib/importWarningMessage";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";
import { IMPORT_WARNING_CODES } from "@/modules/agents/import-warning-codes";

// Every warning the import can emit has a sentence in the editor. transfer.ts can only emit a code on
// the list (`ImportWarning.code` is typed by it), so the list is the whole subject: a code without its
// case would reach the operator as the bare code, and a rename a prompt may still depend on must not
// be quiet.

// Records the key each warning asks for and answers with it, so the assertion is about which sentence
// was chosen, not about its wording.
const keyOf = ((key: string) => key) as unknown as TFunction;

test("every import warning code renders its own sentence", () => {
  expect(IMPORT_WARNING_CODES.length).toBeGreaterThan(10);
  const chosen = IMPORT_WARNING_CODES.map((code) => [
    code,
    importWarningMessage({ code, params: { name: "x", count: 2 } }, keyOf),
  ]);
  expect(chosen).toEqual(
    IMPORT_WARNING_CODES.map((code) => [code, `editor.importWarning.${code}`]),
  );
});

test("and that sentence is in both catalogs", () => {
  const catalogs = { en, "pt-BR": ptBR } as Record<
    string,
    { editor: { importWarning: Record<string, unknown> } }
  >;
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const keys = Object.keys(catalog.editor.importWarning);
    const missing = IMPORT_WARNING_CODES.filter(
      (code) =>
        !keys.includes(code) && !keys.some((k) => k.startsWith(`${code}_`)),
    );
    expect({ locale, missing }).toEqual({ locale, missing: [] });
  }
});
