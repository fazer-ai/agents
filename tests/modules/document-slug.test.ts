import { describe, expect, test } from "bun:test";
import {
  slugifyTemplateName,
  slugProblem,
} from "@/modules/documents/templates";

// The slug is a TOOL NAME, and the operator never types it: it is derived from the template's name.
// So a derivation that cannot produce a usable identifier is a wall in front of a name that was
// perfectly reasonable, about something the operator did not choose and cannot see. Three walls were
// reachable by typing an ordinary name:
//
//   "Orçamento" twice  → the second create was refused, one template per name, forever
//   "2026 Orçamento"   → "2026_orcamento", refused for not starting with a letter
//   "Image"            → "image", refused for colliding with the built-in send_image
//
// Two of those are the derivation's fault and are fixed here: a name is normalised into something a
// tool name may actually be. The THIRD is not a wall to remove — a duplicate name is an authoring
// error, because the name is what the model reads to choose between document tools, and numbering
// the second one would hide it until the agent sent the wrong document. That one is refused, in
// terms of the name, and lives in documents.test.ts where the uniqueness is enforced.

describe("slugifyTemplateName", () => {
  test("derives a usable slug from names that used to produce an invalid one", () => {
    // The leading digit is the case that matters: a year in the name is ordinary, and the slug it
    // produced could never pass `slugProblem`.
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
