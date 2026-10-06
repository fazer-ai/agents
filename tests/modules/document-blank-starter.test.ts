import { describe, expect, test } from "bun:test";
import { DOCUMENT_STYLE_DEFAULTS } from "@/modules/documents/blocks";
import {
  documentStarter,
  documentStarters,
} from "@/modules/documents/starters";
import { parseAuthoredTemplate } from "@/modules/documents/validate";

// The blank starter is the one an operator (or an agent through MCP) configures from scratch, so it
// carries nothing to delete: the single block validation requires (a template must print something,
// or every issued document is a numbered blank page), no fields, the default style, no prefix.
describe("the blank starter", () => {
  for (const locale of ["pt-BR", "en-US"] as const) {
    test(`is offered in ${locale}, after the three ready-made ones`, () => {
      const keys = documentStarters(locale).map((s) => s.key);
      expect(keys).toEqual(["quote", "proposal", "receipt", "blank"]);
    });

    test(`carries only what validation requires (${locale})`, () => {
      const blank = documentStarter("blank", locale);
      if (!blank) throw new Error("no blank starter");
      expect(blank.blocks.length).toBe(1);
      expect(blank.blocks[0]?.type).toBe("header");
      expect(blank.fields).toEqual([]);
      expect(blank.numberPrefix).toBe("");
      expect(blank.style).toEqual({
        ...DOCUMENT_STYLE_DEFAULTS,
        locale,
        currency: locale === "pt-BR" ? "BRL" : "USD",
      });
      expect(blank.name.length).toBeGreaterThan(0);
      expect(blank.description.length).toBeGreaterThan(0);
    });

    test(`passes the same validation a create runs (${locale})`, () => {
      const blank = documentStarter("blank", locale);
      if (!blank) throw new Error("no blank starter");
      const parsed = parseAuthoredTemplate(
        blank.blocks,
        blank.fields,
        blank.style,
      );
      expect(parsed.ok ? "ok" : parsed.reason).toBe("ok");
    });
  }

  test("its name and description are translated, not copied", () => {
    const pt = documentStarter("blank", "pt-BR");
    const en = documentStarter("blank", "en-US");
    expect(pt?.name).not.toBe(en?.name);
    expect(pt?.description).not.toBe(en?.description);
  });

  // The minimum is a real rule and not a habit of this starter: without the header, nothing prints.
  test("dropping its one block is refused", () => {
    const blank = documentStarter("blank", "pt-BR");
    if (!blank) throw new Error("no blank starter");
    const parsed = parseAuthoredTemplate([], [], blank.style);
    expect(parsed.ok).toBe(false);
  });
});
