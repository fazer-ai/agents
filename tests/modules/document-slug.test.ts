import { describe, expect, test } from "bun:test";
import {
  slugifyTemplateName,
  slugProblem,
} from "@/modules/documents/templates";

// The slug is a TOOL NAME derived from the template's name, which the operator never types. A
// derivation that cannot produce a usable identifier would refuse an ordinary name ("2026 Orçamento"
// starts with a digit), so a name is normalised into something a tool name may be. A duplicate name
// stays refused, in terms of the name (documents.test.ts): the name is what the model reads to
// choose between document tools, and numbering the second copy would hide the clash until the agent
// sent the wrong document.

describe("slugifyTemplateName", () => {
  test("derives a usable slug from names that used to produce an invalid one", () => {
    // NOTE: A year in the name is ordinary, and a slug with a leading digit can never pass `slugProblem`.
    for (const name of ["2026 Orçamento", "9", "1º recibo"]) {
      const slug = slugifyTemplateName(name);
      expect(slugProblem(slug)).toBeNull();
    }
  });

  test("still derives the obvious slug when the name already gives one", () => {
    expect(slugifyTemplateName("Orçamento")).toBe("orcamento");
    expect(slugifyTemplateName("Proposta comercial")).toBe(
      "proposta_comercial",
    );
    expect(slugifyTemplateName("Ação!!")).toBe("acao");
  });

  test("never returns an empty slug", () => {
    for (const name of ["___", "!!!", " "]) {
      expect(slugifyTemplateName(name).length).toBeGreaterThan(0);
      expect(slugProblem(slugifyTemplateName(name))).toBeNull();
    }
  });
});
