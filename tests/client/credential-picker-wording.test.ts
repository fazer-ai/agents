import { describe, expect, test } from "bun:test";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";

// The two lines the credential picker draws under an empty or deleted credential are sentences, in
// both languages, with no dash standing in for the punctuation between their two halves.
describe("the credential picker's missing-credential lines", () => {
  test("carry no em or en dash, in either language", () => {
    for (const cat of [en, ptBR]) {
      for (const key of ["requiredMissing", "unresolvedMissing"] as const) {
        expect(/[—–]/.test(cat.credentialPicker[key]), key).toBe(false);
      }
    }
  });
});
