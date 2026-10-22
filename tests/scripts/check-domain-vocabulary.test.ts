import { describe, expect, test } from "bun:test";
import { vocabularyHits } from "@/../scripts/check-domain-vocabulary";

describe("vocabularyHits", () => {
  test.each([
    "e.g. cancelamento, compra-de-ingresso, outros",
    'ex.: a conversa carrega exatamente uma entre \\"compra-de-ingresso\\"',
    "  // whole list is what stops an agent inventing `duvidas-evento`",
    "opens each page at `https://tickets.example/{value}`.",
    "opens each page at `https://example.com/evento_{value}`.",
    "Build your own dashboards (conversations by event, label or outcome)",
    "Monte os seus próprios dashboards (conversas por evento, etiqueta)",
    "as Chatwoot names it (for example: evento).",
    "com o nome que ele tem no Chatwoot (por exemplo: evento).",
  ])("refuses %p", (line) => {
    expect(vocabularyHits("x", line).length).toBeGreaterThan(0);
  });

  test.each([
    "Filter by event name (from GET /events).",
    "Cria um evento na agenda do Google conectada.",
    "Envie eventos assinados para os seus próprios endpoints",
    "Atraso do event loop (p99)",
    "e.g. category-a, category-b, other",
    "conversations by attribute, label or outcome",
    "opens each item's page at `https://example.com/items/{value}`.",
  ])("leaves %p alone", (line) => {
    expect(vocabularyHits("x", line)).toEqual([]);
  });

  test("names the file, the line and the pattern of each hit", () => {
    expect(
      vocabularyHits(
        "a.md",
        "ok\nsee compra-de-ingresso\nok\nconversas por evento",
      ),
    ).toEqual(["a.md:2 /ingresso/i", "a.md:4 /conversas por evento\\b/i"]);
  });
});
