import { describe, expect, test } from "bun:test";
import type { DocumentField } from "@/modules/documents/blocks";
import { sampleValues } from "@/modules/documents/sample";
import { documentStarters } from "@/modules/documents/starters";
import { resolveFooterText } from "@/modules/documents/tokens";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { documentStarterList } from "@/modules/mcp/read";
import { documentTemplateCreate } from "@/modules/mcp/write-documents";

// What an operator meets the first time they make a document: the starter menu's words stay in the
// menu, the preview's sample values read like a document, and an empty company name does not leave
// the footer's separator hanging.

const principal: VerifiedToken = {
  userId: 1n,
  tenantId: 1n,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
};

describe("the blank starter keeps its menu text out of the template", () => {
  for (const locale of ["pt-BR", "en-US"] as const) {
    const starters = documentStarters(locale);
    const blank = starters.find((s) => s.key === "blank");

    test(`${locale}: the blank one suggests no name and describes nothing`, () => {
      if (!blank) throw new Error("no blank starter");
      expect(blank.suggestedName).toBe("");
      expect(blank.description).toBeNull();
      expect(blank.summary.length).toBeGreaterThan(0);
    });

    test(`${locale}: a ready-made one suggests its own name and describes the document`, () => {
      for (const s of starters.filter((x) => x.key !== "blank")) {
        expect(s.suggestedName).toBe(s.name);
        expect(s.description).toBe(s.summary);
      }
    });
  }

  test("the MCP starter list still says what the blank one is", async () => {
    const r = await documentStarterList(principal, { locale: "en-US" });
    expect(r.ok).toBe(true);
    const text = JSON.stringify(r);
    expect(text.includes("Only the header")).toBe(true);
  });

  test("over MCP the blank starter alone is not a name", async () => {
    const r = await documentTemplateCreate(principal, { starter: "blank" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("name is required");
  });
});

describe("preview sample values", () => {
  const fields: DocumentField[] = [
    { name: "cliente", label: "Cliente", type: "text", required: true },
    { name: "itens", label: "Itens", type: "lineItems", required: true },
    { name: "desconto", label: "Desconto", type: "currency" },
    { name: "validade", label: "Validade", type: "date", required: true },
  ];
  const at = new Date("2026-10-07T12:00:00Z");

  for (const locale of ["pt-BR", "en-US"] as const) {
    test(`${locale}: read like a document, not like the field list`, () => {
      const v = sampleValues(fields, at, "2026-10-07", locale);
      expect(v.cliente).not.toBe("Cliente");
      const items = v.itens as {
        description: string;
        quantity: number;
        unitPrice: number;
      }[];
      for (const item of items) {
        expect(/^Itens? \d+$/.test(item.description)).toBe(false);
      }
      const subtotal = items.reduce(
        (sum, i) => sum + i.quantity * i.unitPrice,
        0,
      );
      expect(v.desconto as number).toBeLessThan(subtotal / 2);
    });
  }

  test("a text sample is in the document's language", () => {
    const pt = sampleValues(fields, at, "2026-10-07", "pt-BR").cliente;
    const en = sampleValues(fields, at, "2026-10-07", "en-US").cliente;
    expect(pt).not.toBe(en);
  });
});

describe("footer text", () => {
  const template = "{{company_name}} · {{doc_number}}";

  test("an empty company name leaves no separator at the start", () => {
    expect(
      resolveFooterText(template, { company_name: "", doc_number: "0042" }),
    ).toBe("0042");
  });

  test("an empty last token leaves no separator at the end", () => {
    expect(
      resolveFooterText("{{doc_number}} | {{company_name}}", {
        company_name: "",
        doc_number: "ORC-0042",
      }),
    ).toBe("ORC-0042");
  });

  test("an empty middle token leaves one separator, not two", () => {
    expect(
      resolveFooterText("{{a}} · {{b}} · {{c}}", {
        a: "Acme",
        b: "",
        c: "0042",
      }),
    ).toBe("Acme · 0042");
  });

  test("a full footer is printed as written", () => {
    expect(
      resolveFooterText(template, {
        company_name: "Acme Serviços Ltda",
        doc_number: "0042",
      }),
    ).toBe("Acme Serviços Ltda · 0042");
  });

  test("separators the author wrote stay when every token has a value", () => {
    expect(
      resolveFooterText("• Pagamento em 30 dias", { doc_number: "1" }),
    ).toBe("• Pagamento em 30 dias");
    expect(resolveFooterText("| {{doc_number}} |", { doc_number: "7" })).toBe(
      "| 7 |",
    );
  });

  test("an empty token next to authored text takes only its own separator", () => {
    expect(
      resolveFooterText("Obrigado! · {{company_name}} · {{doc_number}}", {
        company_name: "",
        doc_number: "7",
      }),
    ).toBe("Obrigado! · 7");
  });

  test("an empty token sharing a part with a filled one keeps the separator", () => {
    expect(
      resolveFooterText("{{company_name}} {{company_phone}} | {{doc_number}}", {
        company_name: "Acme",
        company_phone: "",
        doc_number: "0042",
      }),
    ).toBe("Acme | 0042");
  });

  test("a token written across lines still resolves", () => {
    expect(
      resolveFooterText("{{company_name\n}} · {{doc_number}}", {
        company_name: "Acme",
        doc_number: "0042",
      }),
    ).toBe("Acme · 0042");
  });

  test("text that is not a separator is left alone", () => {
    expect(
      resolveFooterText("Obrigado! {{doc_number}}", { doc_number: "7" }),
    ).toBe("Obrigado! 7");
  });
});
