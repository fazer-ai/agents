import { describe, expect, test } from "bun:test";
import { NEW_DOCUMENT_STYLE } from "@/modules/documents/blocks";
import {
  documentStarter,
  documentStarters,
} from "@/modules/documents/starters";
import { parseAuthoredTemplate } from "@/modules/documents/validate";

// The blank starter is the one an operator (or an agent through MCP) configures from scratch, so it
// carries nothing to delete: the single block validation requires (a template must print something,
// or every issued document is a numbered blank page), no fields, the new-template style, no prefix.
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
        ...NEW_DOCUMENT_STYLE,
        locale,
        currency: locale === "pt-BR" ? "BRL" : "USD",
      });
      expect(blank.name.length).toBeGreaterThan(0);
      expect(blank.summary.length).toBeGreaterThan(0);
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

  test("its name and summary are translated, not copied", () => {
    const pt = documentStarter("blank", "pt-BR");
    const en = documentStarter("blank", "en-US");
    expect(pt?.name).not.toBe(en?.name);
    expect(pt?.summary).not.toBe(en?.summary);
  });
});
