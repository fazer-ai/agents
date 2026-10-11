import { describe, expect, test } from "bun:test";
import { getDocumentProxy } from "unpdf";
import { renderDocumentPdf } from "@/modules/documents/render";
import { sampleValues } from "@/modules/documents/sample";
import { documentStarters } from "@/modules/documents/starters";
import { parseTemplateContent } from "@/modules/documents/validate";

// A quote whose line items run past one page: no row is split across the break, the table head is
// printed again on every page the table continues on, and a table that fits the page it starts on
// stays there. Read off the text each page of the PDF actually draws.

const LONG =
  "com uma descrição bem longa que ocupa mais de uma linha na coluna de descrição da tabela de itens do orçamento";

type Item = { description: string; quantity: number; unitPrice: number };

const item = (n: number, long = false): Item => ({
  description: `Item ${n} ${long ? LONG : "serviço"}`,
  quantity: n,
  unitPrice: 10 + n,
});

async function pagesOf(items: Item[], onlyText?: string): Promise<string[][]> {
  const starter = documentStarters("pt-BR").find((s) => s.key === "quote");
  if (!starter) throw new Error("no quote starter");
  const parsed = parseTemplateContent(starter.blocks, starter.fields, {});
  if (!parsed.ok) throw new Error(parsed.reason);
  const field = parsed.content.fields.find((f) => f.type === "lineItems");
  if (!field) throw new Error("the quote starter has no line items");
  const bytes = await renderDocumentPdf({
    blocks:
      onlyText === undefined
        ? parsed.content.blocks
        : [{ id: "only", type: "text", text: onlyText }],
    fields: parsed.content.fields,
    style: starter.style,
    values: {
      ...sampleValues(parsed.content.fields, new Date("2026-09-05T12:00:00Z")),
      [field.name]: items,
    },
    company: {
      name: "Ateliê São João",
      document: "",
      address: "",
      phone: "",
      email: "",
      website: "",
      logoKey: null,
      logoVersion: 0,
    },
    meta: { number: "ORC-0001", date: "05/09/2026", title: "Orçamento" },
  });
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: string[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    pages.push(
      content.items
        .map((i) => ("str" in i ? i.str.trim() : ""))
        .filter((s) => s.length > 0),
    );
  }
  return pages;
}

const pageOf = (pages: string[][], match: (s: string) => boolean) =>
  pages.findIndex((strs) => strs.some(match));

describe("a quote that runs past one page", () => {
  test("no line item is split: its description and its quantity print on the same page", async () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      item(i + 1, i % 2 === 1),
    );
    const pages = await pagesOf(items);
    expect(pages.length).toBeGreaterThan(1);
    const split = items
      .map((it) => ({
        n: it.quantity,
        description: pageOf(pages, (s) => s.startsWith(`Item ${it.quantity} `)),
        quantity: pageOf(pages, (s) => s === String(it.quantity)),
      }))
      .filter((row) => row.description !== row.quantity);
    expect(split).toEqual([]);
  });

  test("the table head is printed on every page the table continues on, and not after it", async () => {
    const pages = await pagesOf(
      Array.from({ length: 45 }, (_, i) => item(i + 1)),
    );
    const withRows = pages
      .map((strs, p) => ({ p, rows: strs.some((s) => /^Item \d+ /.test(s)) }))
      .filter((page) => page.rows)
      .map((page) => page.p);
    expect(withRows.length).toBeGreaterThan(1);
    for (const p of withRows) {
      expect(`${p}:${pages[p]?.includes("Descrição")}`).toBe(`${p}:true`);
      expect(`${p}:${pages[p]?.includes("Valor unit.")}`).toBe(`${p}:true`);
    }

    const ended = await pagesOf(
      Array.from({ length: 22 }, (_, i) => item(i + 1)),
    );
    const after = ended.findIndex((strs) =>
      strs.some((s) => s.startsWith("Prazos são confirmados")),
    );
    expect(ended[after]?.some((s) => /^Item \d+ /.test(s))).toBe(false);
    expect(ended[after]?.includes("Descrição")).toBe(false);
  });

  test("a table that fills the page it starts on stays there instead of jumping to the next", async () => {
    for (const n of [25, 26]) {
      const pages = await pagesOf(
        Array.from({ length: n }, (_, i) => item(i + 1)),
      );
      expect(`${n}:${pageOf(pages, (s) => s.startsWith("Item 1 "))}`).toBe(
        `${n}:0`,
      );
      expect(`${n}:${pageOf(pages, (s) => s.startsWith(`Item ${n} `))}`).toBe(
        `${n}:0`,
      );
    }
  });

  test("a line item taller than a page still prints all of its text", async () => {
    const giant: Item = {
      description: `Item 2 ${"palavra ".repeat(1500)}FIM`,
      quantity: 2,
      unitPrice: 12,
    };
    const pages = await pagesOf([item(1), giant, item(3)]);
    expect(pages.flat().some((s) => s.includes("FIM"))).toBe(true);
    expect(pageOf(pages, (s) => s.startsWith("Item 3 "))).toBeGreaterThan(0);
  });

  test("a document that ends at the bottom of a page has no extra page with only the footer", async () => {
    for (let lines = 56; lines <= 76; lines++) {
      const text = Array.from(
        { length: lines },
        (_, i) => `Linha ${i + 1}`,
      ).join("\n");
      const pages = await pagesOf([], text);
      const empty = pages.findIndex(
        (strs) => !strs.some((s) => s.startsWith("Linha ")),
      );
      expect(`${lines}:${empty}`).toBe(`${lines}:-1`);
    }
  });
});
