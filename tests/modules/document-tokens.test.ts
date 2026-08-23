import { describe, expect, test } from "bun:test";
import { sanitizePromptValue } from "@/graph/prompt";
import { DOCUMENT_STYLE_DEFAULTS } from "@/modules/documents/blocks";
import {
  isReservedTokenName,
  resolveTokens,
  sanitizeDocumentValue,
  tokensIn,
} from "@/modules/documents/tokens";
import { buildDocumentVars } from "@/modules/documents/vars";

const COMPANY = {
  name: "Ateliê São João",
  document: "12.345.678/0001-90",
  address: "Rua das Acácias, 120",
  phone: "(11) 99999-0000",
  email: "contato@exemplo.com",
  website: "exemplo.com",
  logoKey: null,
  logoVersion: 0,
};

const META = { number: "ORC-0042", date: "05/09/2026", title: "Orçamento" };

describe("sanitizeDocumentValue", () => {
  // The load-bearing difference from its prompt sibling. That one collapses every run of whitespace
  // into one space, which is right for a value spliced into a single line of a prompt and wrong here:
  // a "notes" or "payment terms" field is legitimately several lines, and collapsing them turns a
  // formatted document into one paragraph.
  test("keeps line breaks, where the prompt sibling collapses them", () => {
    const input = "Entrega em 5 dias\nPagamento: 50% na aprovação";
    expect(sanitizeDocumentValue(input)).toBe(input);
    expect(sanitizePromptValue(input)).not.toContain("\n");
  });

  // U+0085 (NEL) is a line break to plenty of renderers and JS `\s` does NOT match it, so a filter
  // written around \s lets it through and a value can still forge a line of its own.
  test("drops C0, DEL and C1 control characters, NEL included", () => {
    expect(sanitizeDocumentValue("a\u0000b")).toBe("a b");
    expect(sanitizeDocumentValue("a\u007fb")).toBe("a b");
    expect(sanitizeDocumentValue("a\u0085b")).toBe("a b");
    expect(sanitizeDocumentValue("a\u009bb")).toBe("a b");
    expect(sanitizeDocumentValue("a\rb")).toBe("a b");
    // The NEL row is the one that matters: JS `\s` does not match U+0085, so a check written around
    // \s reports a string carrying it as clean.
    expect(/\s/.test("\u0085")).toBe(false);
  });

  // The cut at the far end is `clipText`, which the astral sweep covers. This is the OTHER half of
  // the same problem and the sweep cannot reach it: an unpaired surrogate that was never cut, but
  // spelled out by the JSON source it arrived in (`"\ud800"`) — which is what a model writing a tool
  // call and a mirrored Chatwoot attribute both are. It survives `clipText` untouched, and the
  // snapshot it lands in is a `jsonb` column, where Postgres refuses the whole write.
  test("drops half a character that arrived that way, and keeps whole ones", () => {
    const lone = "\ud800";
    expect(sanitizeDocumentValue(`Eve${lone}Ana 😀`)).toBe("Eve Ana 😀");
    expect(JSON.stringify(sanitizeDocumentValue(`a${lone}b`))).not.toContain(
      "\\ud8",
    );
  });

  test("collapses runs of blank lines and trailing spaces, and bounds the length", () => {
    expect(sanitizeDocumentValue("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(sanitizeDocumentValue("a   \nb")).toBe("a\nb");
    expect(sanitizeDocumentValue("x".repeat(5_000)).length).toBe(2_000);
    expect(sanitizeDocumentValue(null)).toBe("");
  });
});

describe("tokensIn", () => {
  test("finds each token once, in order", () => {
    expect(tokensIn("{{a}} {{b}} {{ a }}")).toEqual(["a", "b"]);
  });

  // The character class is what makes a declared field name token-safe by construction. Anything
  // outside it is not a token, so it can never resolve and can never be silently blanked.
  test("ignores anything outside the token character class", () => {
    expect(tokensIn("{{A}} {{1a}} {{a-b}} {{a.b}} { {a} }")).toEqual([]);
    expect(tokensIn("{{a1_b}}")).toEqual(["a1_b"]);
  });
});

describe("resolveTokens", () => {
  test("replaces a known token and blanks an unknown one", () => {
    expect(resolveTokens("Olá {{nome}}!", { nome: "Ana" })).toBe("Olá Ana!");
    // By the time text reaches the renderer the template was validated, so an unknown token is our
    // bug — and printing `{{foo}}` in a document the customer keeps is a worse way to report it than
    // printing nothing.
    expect(resolveTokens("Prazo: {{prazo}}", {})).toBe("Prazo: ");
  });

  test("sanitizes what it substitutes", () => {
    expect(resolveTokens("{{x}}", { x: "a\u0000b" })).toBe("a b");
  });
});

describe("isReservedTokenName", () => {
  test("covers both spellings of both namespaces", () => {
    for (const name of [
      "company_name",
      "empresa_nome",
      "doc_number",
      "documento_numero",
    ]) {
      expect(isReservedTokenName(name)).toBe(true);
    }
    expect(isReservedTokenName("cliente")).toBe(false);
    expect(isReservedTokenName("companhia")).toBe(false);
  });
});

describe("buildDocumentVars", () => {
  const fields = [
    { name: "cliente", label: "Cliente", type: "text" as const },
    { name: "desconto", label: "Desconto", type: "currency" as const },
    { name: "qtd", label: "Qtd", type: "number" as const },
    { name: "validade", label: "Validade", type: "date" as const },
    { name: "itens", label: "Itens", type: "lineItems" as const },
  ];

  test("answers to the canonical name and to its pt-BR alias alike", () => {
    const vars = buildDocumentVars({
      company: COMPANY,
      meta: META,
      fields: [],
      values: {},
      style: DOCUMENT_STYLE_DEFAULTS,
    });
    expect(vars.company_name).toBe("Ateliê São João");
    expect(vars.empresa_nome).toBe("Ateliê São João");
    expect(vars.doc_number).toBe("ORC-0042");
    expect(vars.documento_numero).toBe("ORC-0042");
  });

  // Formatting HERE rather than at each use site is what makes a price written into a paragraph come
  // out identical to the same price in the totals block. Two spellings of one number in one document
  // is the kind of inconsistency a customer reads as an error.
  test("formats each field by its declared type, in the document's locale", () => {
    const vars = buildDocumentVars({
      company: COMPANY,
      meta: META,
      fields,
      values: {
        cliente: "Ana",
        desconto: 1299.9,
        qtd: 2.5,
        validade: "2026-09-05",
        itens: [{ description: "x", quantity: 1, unitPrice: 1 }],
      },
      style: DOCUMENT_STYLE_DEFAULTS,
    });
    expect(vars.cliente).toBe("Ana");
    // NBSP written as an escape: pt-BR currency puts U+00A0 between the symbol and the
    // number, and a raw one here is invisible to the next person editing the line.
    expect(vars.desconto).toBe("R$\u00a01.299,90");
    expect(vars.qtd).toBe("2,5");
    expect(vars.validade).toBe("05/09/2026");
    // A table is not a token: printing a JSON array into a sentence would be worse than nothing.
    expect(vars.itens).toBe("");
  });

  test("an unsupplied field resolves to empty, not to undefined", () => {
    const vars = buildDocumentVars({
      company: COMPANY,
      meta: META,
      fields,
      values: {},
      style: DOCUMENT_STYLE_DEFAULTS,
    });
    for (const f of fields) expect(vars[f.name]).toBe("");
  });
});
