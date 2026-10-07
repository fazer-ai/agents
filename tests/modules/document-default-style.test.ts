import { describe, expect, test } from "bun:test";
import {
  DOCUMENT_STYLE_DEFAULTS,
  NEW_DOCUMENT_STYLE,
  newTemplateStyle,
  parseDocumentStyle,
} from "@/modules/documents/blocks";
import { documentStarters } from "@/modules/documents/starters";

// The default style is ONE object, and every starter inherits it: the look is changed in one place,
// so the blank starter and the three ready-made ones cannot drift into different documents.
describe("the default document style", () => {
  test("is the finished look: navy accent, page numbers on", () => {
    expect(DOCUMENT_STYLE_DEFAULTS.accentColor).toBe("#1e3a8a");
    expect(DOCUMENT_STYLE_DEFAULTS.showPageNumbers).toBe(true);
  });

  for (const locale of ["pt-BR", "en-US"] as const) {
    test(`every starter, the blank one included, is the new-template style (${locale})`, () => {
      for (const starter of documentStarters(locale)) {
        expect({ key: starter.key, ...starter.style }).toEqual({
          key: starter.key,
          ...NEW_DOCUMENT_STYLE,
          locale,
          currency: locale === "pt-BR" ? "BRL" : "USD",
        });
      }
    });
  }

  // A new template starts with the footer the starters carry; a stored row without one does not
  // grow one on read (below), and an explicit empty footer is the way to have none.
  test("a new template's style gets the footer unless it names its own", () => {
    expect(NEW_DOCUMENT_STYLE.footerText).toBe(
      "{{company_name}} · {{doc_number}}",
    );
    expect(newTemplateStyle(undefined)).toEqual({
      footerText: NEW_DOCUMENT_STYLE.footerText,
    });
    expect(newTemplateStyle({ locale: "en-US", currency: "USD" })).toEqual({
      footerText: NEW_DOCUMENT_STYLE.footerText,
      locale: "en-US",
      currency: "USD",
    });
    expect(newTemplateStyle({ footerText: "" })).toEqual({ footerText: "" });
  });

  // A stored template keeps what it stored: the new default only fills what a row never had.
  test("a stored style keeps its own values", () => {
    const stored = parseDocumentStyle({
      font: "sans",
      baseFontSize: 10,
      accentColor: "#111827",
      margin: "normal",
      pageSize: "A4",
      locale: "pt-BR",
      currency: "BRL",
      showPageNumbers: false,
    });
    expect(stored.accentColor).toBe("#111827");
    expect(stored.showPageNumbers).toBe(false);
    expect(stored.footerText).toBeUndefined();
  });
});
