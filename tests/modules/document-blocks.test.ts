import { describe, expect, test } from "bun:test";
import {
  DOCUMENT_STYLE_DEFAULTS,
  documentAuthoringSchema,
  documentStyleSchema,
  MAX_BLOCKS_PER_DOCUMENT,
  MAX_DOCUMENT_AMOUNT,
  MAX_FIELDS_PER_DOCUMENT,
  MAX_LINE_ITEMS,
  MAX_TOKENS_PER_DOCUMENT,
  parseDocumentStyle,
} from "@/modules/documents/blocks";
import { printedDate } from "@/modules/documents/issue";
import { sampleValues } from "@/modules/documents/sample";
import { documentStarter } from "@/modules/documents/starters";
import { computeTotals } from "@/modules/documents/totals";
import {
  authoredStyleProblem,
  parseAuthoredTemplate,
  parseDocumentValues,
  parseTemplateContent,
} from "@/modules/documents/validate";

// The authoring rules as a table. Every row states one rule from the header of `validate.ts`, and
// the DB-backed suite then proves the write path applies the decision rather than proving the
// decision is right.
//
// The rule this file exists for: a template must be refused at AUTHORING time when a token would not
// resolve. Downstream it becomes a blank space in a PDF the customer keeps, and nothing anywhere
// reports it.

const FIELDS = [
  { name: "cliente", label: "Cliente", type: "text", required: true },
  { name: "itens", label: "Itens", type: "lineItems" },
  { name: "desconto", label: "Desconto", type: "currency" },
  { name: "validade", label: "Validade", type: "date" },
];

function blocks(...extra: unknown[]): unknown[] {
  return [{ id: "h", type: "header", title: "Orçamento" }, ...extra];
}

// ── the authoring gate ──
//
// Two questions, deliberately answered differently. Reading a STORED row has to be tolerant: a row
// written by a newer build must still render, so an unknown key is dropped rather than fatal.
// Reading an AUTHORED template has to be strict: what the operator wrote either takes effect or is
// refused by name, because the alternative is a template that silently differs from the one they
// submitted and nothing anywhere says so.
describe("token amplification", () => {
  // The input bounds do not bound the OUTPUT. One 5,000-character block can hold a thousand tokens,
  // each resolving to a 2,000-character value, so it expands to megabytes — on the request thread,
  // before layout, for any authenticated tenant. The ceiling is on the amplifier because that is the
  // half known when the template is written.
  test("refuses more tokens than the ceiling, counting repeats", () => {
    const many = `{{cliente}} `.repeat(MAX_TOKENS_PER_DOCUMENT + 1);
    const r = parseTemplateContent(
      blocks({ id: "t", type: "text", text: many }),
      FIELDS,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(
      String(MAX_TOKENS_PER_DOCUMENT),
    );
  });

  // Across the DOCUMENT, not per block: sixty blocks of two tokens cost what one block of a hundred
  // and twenty costs.
  test("counts across every block and the footer", () => {
    const spread = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      type: "text",
      text: "{{cliente}} {{validade}}",
    }));
    const r = parseTemplateContent(spread, FIELDS, {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("120");
  });

  test("a real template is nowhere near it", () => {
    const starter = documentStarter("quote", "pt-BR");
    if (!starter) throw new Error("no starter");
    expect(
      parseTemplateContent(starter.blocks, starter.fields, starter.style).ok,
    ).toBe(true);
  });
});

describe("parseAuthoredTemplate (writes) vs parseTemplateContent (stored rows)", () => {
  test("names a misspelled block property instead of dropping it", () => {
    const bad = [{ id: "t", type: "text", text: "Olá", alignn: "center" }];
    const authored = parseAuthoredTemplate(bad, FIELDS, {});
    expect(authored.ok).toBe(false);
    expect(authored.ok === false && authored.reason).toContain("alignn");
    // …and the stored reader still takes it, minus the key it does not know.
    const stored = parseTemplateContent(bad, FIELDS, {});
    expect(stored.ok).toBe(true);
  });

  test("names a misspelled key nested inside a block", () => {
    const r = parseAuthoredTemplate(
      [
        {
          id: "h",
          type: "header",
          meta: [{ label: "Cliente", value: "{{cliente}}", bold: true }],
        },
      ],
      FIELDS,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("bold");
  });

  // The one shape of unknown key a naive `in` check cannot see: it is on Object.prototype, so it
  // reads as present on the parsed output while Zod actually stripped it.
  test("names a key that only exists on the prototype chain", () => {
    for (const key of ["constructor", "toString"]) {
      const r = parseAuthoredTemplate(
        [{ id: "t", type: "text", text: "Olá", [key]: "x" }],
        FIELDS,
        {},
      );
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain(key);
    }
  });

  test("names a misspelled field property", () => {
    const r = parseAuthoredTemplate(
      blocks(),
      [{ name: "cliente", label: "Cliente", type: "text", requred: true }],
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("requred");
  });

  // The tolerant reader answers an invalid style by returning EVERY default, so a write that named
  // one bad colour would be saved with the operator's font, margin and currency thrown away too —
  // and reported as a success.
  test("refuses an invalid style value rather than resetting the whole style", () => {
    const r = parseAuthoredTemplate(blocks(), FIELDS, {
      font: "serif",
      accentColor: "red",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("accentColor");
    // The stored reader keeps its tolerance: a row like that still renders, on defaults.
    expect(
      parseTemplateContent(blocks(), FIELDS, {
        font: "serif",
        accentColor: "red",
      }).ok,
    ).toBe(true);
  });

  test("names a misspelled style property", () => {
    const r = parseAuthoredTemplate(blocks(), FIELDS, { fontt: "serif" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("fontt");
  });

  // baseFontSize is CLAMPED, not refused (docs/mcp.md: "type and choice, never size"), and the clamp
  // changes a value rather than dropping a key — so it must survive the strict pass.
  test("still clamps the base font size instead of refusing it", () => {
    const r = parseAuthoredTemplate(blocks(), FIELDS, { baseFontSize: 400 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.content.style.baseFontSize).toBe(14);
  });

  test("accepts a well-formed template and returns the parsed style", () => {
    const r = parseAuthoredTemplate(blocks(), FIELDS, { font: "mono" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.content.style.font).toBe("mono");
  });

  // The declared fields become the agent's tool schema, published on every turn. Unbounded, a single
  // write turns every turn of every granted agent into a payload the provider may refuse outright.
  test("refuses more declared fields than the ceiling", () => {
    const many = Array.from(
      { length: MAX_FIELDS_PER_DOCUMENT + 1 },
      (_, i) => ({
        name: `campo_${i}`,
        label: `Campo ${i}`,
        type: "text",
      }),
    );
    const r = parseAuthoredTemplate([], many, {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(
      String(MAX_FIELDS_PER_DOCUMENT),
    );
  });
});

describe("parseTemplateContent", () => {
  test("accepts a template whose tokens all resolve", () => {
    const r = parseTemplateContent(
      blocks(
        {
          id: "t",
          type: "text",
          text: "Olá {{cliente}}, vale até {{validade}}.",
        },
        { id: "li", type: "lineItems", field: "itens" },
        {
          id: "tot",
          type: "totals",
          field: "itens",
          discountField: "desconto",
        },
      ),
      FIELDS,
      {},
    );
    expect(r.ok).toBe(true);
  });

  // The footer is rendered through the SAME token resolver the block texts are, and it prints on
  // every page. A typo there is the most invisible kind: it costs a blank on the last line of a
  // document the customer keeps, and nothing in the console ever says so.
  test("refuses an unresolvable token in the style's footer", () => {
    const r = parseTemplateContent(blocks(), FIELDS, {
      footerText: "{{empresa}} · {{doc_number}}",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("footerText");
    expect(r.ok === false && r.reason).toContain("empresa");
  });

  test("accepts a footer built from declared fields and reserved names", () => {
    const r = parseTemplateContent(blocks(), FIELDS, {
      footerText: "{{company_name}} · {{doc_number}} · {{cliente}}",
    });
    expect(r.ok).toBe(true);
  });

  // A token the RESOLVER cannot even read as a name. It matches nothing, so the "unknown token"
  // scan never saw it and authoring succeeded — and then the resolver did not match it either, so
  // the braces printed verbatim in a document the customer keeps. The invariant is that an
  // expression which will not resolve is refused when written, and that has to include the ones we
  // could not parse as a name at all.
  test("refuses a token expression the resolver cannot read", () => {
    for (const text of [
      "Olá {{Cliente}}",
      "Olá {{company-name}}",
      "Olá {{ 1cliente }}",
      "Olá {{}}",
      // Unclosed and nested: neither is brace-BALANCED, so a pattern that matches pairs cannot see
      // them — and both print their braces just the same.
      "Olá {{cliente",
      "Olá {{foo {{cliente}}",
      "Olá cliente}}",
    ]) {
      const r = parseTemplateContent(
        blocks({ id: "t", type: "text", text }),
        FIELDS,
        {},
      );
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain("not a readable token");
    }
    // The same rule on the footer, which prints on every page.
    // A valid token beside an unclosed one: the valid half must not hide the broken one.
    expect(
      parseTemplateContent(
        blocks({ id: "t", type: "text", text: "{{cliente}} e {{valid" }),
        FIELDS,
        {},
      ).ok,
    ).toBe(false);
    const footer = parseTemplateContent(blocks(), FIELDS, {
      footerText: "{{Company_name}}",
    });
    expect(footer.ok).toBe(false);
    expect(footer.ok === false && footer.reason).toContain("footerText");
  });

  // A lineItems field is DECLARED, so it passes the "known name" test — and resolves to the empty
  // string, because a table is not a token. Accepted, authoring succeeds and the customer's document
  // carries a blank exactly where the operator expected their items.
  test("refuses a token naming a lineItems field", () => {
    const r = parseTemplateContent(
      blocks({ id: "t", type: "text", text: "Itens: {{itens}}" }),
      FIELDS,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("lineItems block");
    // The same field is still fine where it belongs — as a block's `field`, not as a token.
    expect(
      parseTemplateContent(
        blocks({ id: "li", type: "lineItems", field: "itens" }),
        FIELDS,
        {},
      ).ok,
    ).toBe(true);
  });

  test("accepts a reserved token without a field behind it", () => {
    const r = parseTemplateContent(
      blocks({
        id: "t",
        type: "text",
        text: "{{company_name}} · {{empresa_documento}} · {{doc_number}}",
      }),
      FIELDS,
      {},
    );
    expect(r.ok).toBe(true);
  });

  // The rule the file exists for.
  test("refuses a token that names neither a field nor a reserved name", () => {
    const r = parseTemplateContent(
      blocks({ id: "t", type: "text", text: "Prazo: {{prazo}}" }),
      FIELDS,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("{{prazo}}");
  });

  // A token in a header's meta value reaches the customer exactly like one in a paragraph. This is
  // the row that catches a text-carrying property nobody remembered to validate.
  test("checks tokens in a header's meta and in a fields block, not only in text", () => {
    const inMeta = parseTemplateContent(
      [
        {
          id: "h",
          type: "header",
          meta: [{ label: "Validade", value: "{{inexistente}}" }],
        },
      ],
      FIELDS,
      {},
    );
    expect(inMeta.ok).toBe(false);
    const inRows = parseTemplateContent(
      blocks({
        id: "f",
        type: "fields",
        rows: [{ label: "Total", value: "{{inexistente}}" }],
      }),
      FIELDS,
      {},
    );
    expect(inRows.ok).toBe(false);
  });

  test("refuses a field whose name would shadow the letterhead", () => {
    const r = parseTemplateContent(
      blocks(),
      [{ name: "empresa_nome", label: "Nome", type: "text" }],
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("reserved prefix");
  });

  test("refuses a duplicate field name and a duplicate block id", () => {
    const dupField = parseTemplateContent(
      blocks(),
      [
        { name: "x", label: "A", type: "text" },
        { name: "x", label: "B", type: "text" },
      ],
      {},
    );
    expect(dupField.ok).toBe(false);
    const dupBlock = parseTemplateContent(
      [
        { id: "same", type: "divider" },
        { id: "same", type: "divider" },
      ],
      [],
      {},
    );
    expect(dupBlock.ok).toBe(false);
    expect(dupBlock.ok === false && dupBlock.reason).toContain(
      "duplicate block id",
    );
  });

  test("refuses a lineItems block pointing at a missing field, or at the wrong type", () => {
    const missing = parseTemplateContent(
      blocks({ id: "li", type: "lineItems", field: "nao_existe" }),
      FIELDS,
      {},
    );
    expect(missing.ok).toBe(false);
    const wrongType = parseTemplateContent(
      blocks({ id: "li", type: "lineItems", field: "cliente" }),
      FIELDS,
      {},
    );
    expect(wrongType.ok).toBe(false);
    expect(wrongType.ok === false && wrongType.reason).toContain("lineItems");
  });

  test("refuses a totals discountField that is not an amount", () => {
    const r = parseTemplateContent(
      blocks({
        id: "tot",
        type: "totals",
        field: "itens",
        discountField: "validade",
      }),
      FIELDS,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("discountField");
  });

  test("refuses an unknown block type, naming the ones that exist", () => {
    const r = parseTemplateContent([{ id: "x", type: "image" }], [], {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("lineItems");
  });

  // The preview renders on the request thread with operator-supplied input, so the bound is checked
  // BEFORE anything is laid out.
  test("refuses more blocks than the ceiling", () => {
    const many = Array.from(
      { length: MAX_BLOCKS_PER_DOCUMENT + 1 },
      (_, i) => ({
        id: `b${i}`,
        type: "divider",
      }),
    );
    const r = parseTemplateContent(many, [], {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(
      String(MAX_BLOCKS_PER_DOCUMENT),
    );
  });
});

describe("parseDocumentValues", () => {
  test("accepts the declared shapes and drops nothing", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [{ description: "Serviço", quantity: 2, unitPrice: 100 }],
      desconto: 50,
      validade: "2026-09-01",
    });
    expect(r.ok).toBe(true);
    expect(r.ok === true && Object.keys(r.values).sort()).toEqual([
      "cliente",
      "desconto",
      "itens",
      "validade",
    ]);
  });

  test("refuses a missing required field, and allows a missing optional one", () => {
    const missing = parseDocumentValues(FIELDS as never, { itens: [] });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.reason).toContain("cliente");
    const optional = parseDocumentValues(FIELDS as never, { cliente: "Ana" });
    expect(optional.ok).toBe(true);
  });

  // WHAT IS VALIDATED AND WHAT IS STORED HAVE TO BE THE SAME STRING.
  //
  // The printability check runs on a SANITISED copy — deliberately, because that is the form the
  // renderer receives — and a line item's description is then stored in that form. A scalar was
  // stored RAW, so the snapshot held a character the check had already normalised away. The snapshot
  // is a `jsonb` column and an unpaired surrogate is refused there outright (`22P02`), so the
  // disagreement did not print oddly: it made the whole issuance fail at the INSERT, after the
  // number was taken.
  test("stores the sanitised text, not the string it was handed", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: `Ana\ud800\tMaria`,
      itens: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stored = r.values.cliente as string;
    // Serialised before the assertion, so half a character cannot ride into the diff of a failure.
    expect(JSON.stringify(stored)).not.toContain("\\ud8");
    // …and the tab became a space, which is what the renderer would have drawn anyway.
    expect(stored).toBe("Ana Maria");
  });

  // A key the template never declared is refused rather than ignored: silently dropping it is how a
  // model believes it sent a value that never reaches the page.
  test("refuses a key the template does not declare", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      observacao: "algo",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("observacao");
  });

  // A pre-formatted date cannot be re-rendered in the document's locale, so it is refused at the
  // door rather than printed as a Brazilian date in the middle of an en-US page.
  test("refuses a date that is not ISO", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      validade: "01/09/2026",
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("ISO date");
  });

  // Shape is not enough: a date the calendar does not have is a string of the right form, and the
  // renderer does not refuse it — JavaScript rolls 2026-02-31 forward to March 3, so the customer
  // keeps a PDF carrying a date nobody typed. It has to round-trip to the same day or be refused.
  test("refuses a date the calendar does not have", () => {
    for (const validade of [
      "2026-02-31",
      "2026-13-01",
      "2026-04-31",
      "2026-00-10",
    ]) {
      const r = parseDocumentValues(FIELDS as never, {
        cliente: "Ana",
        validade,
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain("ISO date");
    }
    // The leap day of a leap year is a real date, and stays one.
    expect(
      parseDocumentValues(FIELDS as never, {
        cliente: "Ana",
        validade: "2028-02-29",
      }).ok,
    ).toBe(true);
    expect(
      parseDocumentValues(FIELDS as never, {
        cliente: "Ana",
        validade: "2026-02-29",
      }).ok,
    ).toBe(false);
  });

  test("refuses a non-finite amount and a malformed line item", () => {
    const nan = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      desconto: Number.POSITIVE_INFINITY,
    });
    expect(nan.ok).toBe(false);
    const bad = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [{ description: "x" }],
    });
    expect(bad.ok).toBe(false);
  });

  // "Required" has to mean the document ends up with the thing. An empty list is present, so it
  // clears the missing-value check, and the array parser has nothing to object to — leaving an agent
  // able to issue a numbered quote with no rows and a total of zero, in front of a customer, with
  // every gate reporting success.
  test("refuses an empty list for a required lineItems field", () => {
    const r = parseDocumentValues(
      [
        { name: "itens", label: "Itens", type: "lineItems", required: true },
      ] as never,
      { itens: [] },
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("itens");
    // An OPTIONAL list is different: nothing was promised, and the block simply renders empty.
    const optional = parseDocumentValues(
      [{ name: "extras", label: "Extras", type: "lineItems" }] as never,
      { extras: [] },
    );
    expect(optional.ok).toBe(true);
  });

  // Required has to mean the customer READS something. Whitespace and control characters are
  // non-empty as a string and empty once sanitised, so a required customer name could clear every
  // gate and come out as a blank line on a numbered document.
  test("refuses required text that is blank once sanitised", () => {
    const required = [
      { name: "cliente", label: "Cliente", type: "text", required: true },
    ] as never;
    for (const cliente of ["   ", "\u0000\u0001", "\u00a0\u00a0"]) {
      const r = parseDocumentValues(required, { cliente });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain("cliente");
    }
    expect(parseDocumentValues(required, { cliente: " Ana " }).ok).toBe(true);
    // An OPTIONAL text field is free to be blank: nothing was promised.
    expect(
      parseDocumentValues(
        [{ name: "obs", label: "Obs", type: "text" }] as never,
        { obs: "   " },
      ).ok,
    ).toBe(true);
  });

  // Finite is not the same as usable. The arithmetic is in integer cents, so a unit price of 1e308
  // clears `Number.isFinite` and then becomes Infinity in cents — a numbered PDF whose total reads
  // as infinity, or, one order down, one that is merely wrong.
  test("refuses amounts the cent arithmetic cannot hold", () => {
    const over = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      desconto: 1e308,
    });
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.reason).toContain("at most");

    // A factor is PRINTED on the line, so one enormous factor against a zero one keeps the product
    // inside the cap and still puts an unreadable number in front of the customer.
    const factor = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [{ description: "Zerado", quantity: 0, unitPrice: 1e308 }],
    });
    expect(factor.ok).toBe(false);
    expect(factor.ok === false && factor.reason).toContain("Zerado");

    // A quantity and a unit price can each be inside the cap while their product is outside it.
    const line = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [
        {
          description: "Consultoria",
          quantity: MAX_DOCUMENT_AMOUNT,
          unitPrice: MAX_DOCUMENT_AMOUNT,
        },
      ],
    });
    expect(line.ok).toBe(false);
    expect(line.ok === false && line.reason).toContain("Consultoria");

    // A full document at the ceiling still adds up exactly: MAX_LINE_ITEMS lines of the cap stay
    // inside the safe-integer range the cents live in, which is how the cap was chosen.
    const atCeiling = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: Array.from({ length: MAX_LINE_ITEMS }, () => ({
        description: "x",
        quantity: 1,
        unitPrice: MAX_DOCUMENT_AMOUNT,
      })),
    });
    expect(atCeiling.ok).toBe(true);
    const totals = computeTotals(
      Array.from({ length: MAX_LINE_ITEMS }, () => ({
        description: "x",
        quantity: 1,
        unitPrice: MAX_DOCUMENT_AMOUNT,
      })),
    );
    expect(Number.isSafeInteger(Math.round(totals.total * 100))).toBe(true);
    expect(totals.total).toBe(MAX_LINE_ITEMS * MAX_DOCUMENT_AMOUNT);
  });

  // A description is printed on a PRICED row, so whitespace is the same defect as a blank required
  // field: a numbered financial document with an empty line carrying a price.
  // Strict, like the tool schema the model sees. Stripped, a caller that put a discount inside a
  // line item got a 200 and a document without it — and the value stayed in the snapshot, ignored
  // by the renderer, which is the most confusing version of that outcome.
  test("refuses an undeclared key inside a line item", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [{ description: "x", quantity: 1, unitPrice: 2, desconto: 10 }],
    });
    expect(r.ok).toBe(false);
  });

  // The renderer prints an item's description DIRECTLY — unlike a field value, which goes through
  // the token resolver's sanitiser — so a tab or a control character in it reaches the PDF and
  // rearranges the table. What survives sanitising is what gets stored.
  test("stores line-item descriptions as they will be printed", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [
        {
          description: "Consultoria\tavançada\u0007",
          quantity: 1,
          unitPrice: 2,
        },
      ],
    });
    expect(r.ok).toBe(true);
    const items = r.ok ? (r.values.itens as { description: string }[]) : [];
    expect(items[0]?.description).not.toContain("\u0007");
    expect(items[0]?.description).toContain("Consultoria");
  });

  test("refuses a line item whose description renders blank", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: [{ description: "   ", quantity: 1, unitPrice: 100 }],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("description");
  });

  test("refuses more line items than the ceiling", () => {
    const r = parseDocumentValues(FIELDS as never, {
      cliente: "Ana",
      itens: Array.from({ length: MAX_LINE_ITEMS + 1 }, () => ({
        description: "x",
        quantity: 1,
        unitPrice: 1,
      })),
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain(String(MAX_LINE_ITEMS));
  });
});

// The currency code is drawn beside every amount, and a length check let two different failures
// through: "$$$" makes Intl throw, so the renderer's fallback prints the raw code next to the
// number, and a code outside Latin-1 is drawn as a different character in every price on the page.
describe("the currency code is three letters", () => {
  test("refuses a three-character value that is not a code", () => {
    expect(parseDocumentStyle({ currency: "$$$" }).currency).toBe(
      DOCUMENT_STYLE_DEFAULTS.currency,
    );
    expect(parseDocumentStyle({ currency: "中AB" }).currency).toBe(
      DOCUMENT_STYLE_DEFAULTS.currency,
    );
  });

  // Case is a SPELLING, not a different currency: normalised rather than refused, beside the
  // baseFontSize clamp and for the same reason.
  test("normalises case instead of refusing it", () => {
    expect(parseDocumentStyle({ currency: "brl" }).currency).toBe("BRL");
    expect(parseDocumentStyle({ currency: "usd" }).currency).toBe("USD");
  });
});

describe("parseDocumentStyle", () => {
  test("fills defaults and keeps what was supplied", () => {
    const s = parseDocumentStyle({ font: "serif", accentColor: "#AABBCC" });
    expect(s.font).toBe("serif");
    expect(s.accentColor).toBe("#AABBCC");
    expect(s.pageSize).toBe(DOCUMENT_STYLE_DEFAULTS.pageSize);
  });

  // The size is CLAMPED, not refused: the MCP schema publishes no bound (docs/mcp.md, "type and
  // choice, never size"), so a bound enforced here would accept in the console what it rejects over
  // MCP for the same write.
  test("clamps the base font size instead of refusing it", () => {
    expect(parseDocumentStyle({ baseFontSize: 40 }).baseFontSize).toBe(14);
    expect(parseDocumentStyle({ baseFontSize: 2 }).baseFontSize).toBe(8);
    expect(parseDocumentStyle({ baseFontSize: 10.4 }).baseFontSize).toBe(10);
  });

  // Per KEY, not per object. `.partial().safeParse` fails wholesale, so ONE property this version
  // cannot read — a font family a newer build wrote — replaced every setting with its default, and
  // the console then saved those defaults back: a patch of one property resetting the other eight
  // while reporting success.
  test("keeps the settings it understands beside one it does not", () => {
    const parsed = parseDocumentStyle({
      font: "brand-grotesk-2027",
      accentColor: "#123456",
      margin: "wide",
      locale: "en-US",
      currency: "usd",
      showPageNumbers: true,
    });
    expect(parsed.font).toBe(DOCUMENT_STYLE_DEFAULTS.font);
    expect(parsed.accentColor).toBe("#123456");
    expect(parsed.margin).toBe("wide");
    expect(parsed.locale).toBe("en-US");
    expect(parsed.currency).toBe("USD");
    expect(parsed.showPageNumbers).toBe(true);
  });

  test("falls back to defaults for a block written by an older version", () => {
    expect(parseDocumentStyle({ font: "comic-sans" })).toEqual(
      DOCUMENT_STYLE_DEFAULTS,
    );
    expect(parseDocumentStyle(null)).toEqual(DOCUMENT_STYLE_DEFAULTS);
  });
});

// The values a MODEL writes reach the page too, and a model reaches for an emoji, or for a
// customer's name in its own script, without being asked. Printed as-is they come out as a
// different Latin character, so they are refused — an error the model can act on beats a name
// silently misspelled in a document the customer keeps.
describe("printed values have to be printable", () => {
  const fields = [
    { name: "cliente", label: "Cliente", type: "text" as const },
    { name: "itens", label: "Itens", type: "lineItems" as const },
  ];

  test("refuses a text value and a line-item description", () => {
    const bad = parseDocumentValues(fields, { cliente: "李伟", itens: [] });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.reason).toContain("李");

    const badItem = parseDocumentValues(fields, {
      cliente: "Ana",
      itens: [{ description: "Serviço 😀", quantity: 1, unitPrice: 10 }],
    });
    expect(badItem.ok).toBe(false);
  });

  test("ordinary Portuguese passes", () => {
    expect(
      parseDocumentValues(fields, {
        cliente: "João Conceição",
        itens: [
          { description: "Instalação — 2ª via", quantity: 1, unitPrice: 10 },
        ],
      }).ok,
    ).toBe(true);
  });
});

// A template that draws NOTHING is not a document, and it is the DEFAULT shape: `blocks` defaults
// to [] and a template defaults to enabled, so an omitted layout became a granted tool that issued a
// numbered blank page — a burned number from the sequence and an empty PDF attached to a customer's
// conversation.
describe("a layout has to print something", () => {
  const field = { name: "cliente", label: "Cliente", type: "text" };

  test("refuses an empty layout, and one that only draws rules", () => {
    expect(parseAuthoredTemplate([], [field], {}).ok).toBe(false);
    expect(
      parseAuthoredTemplate(
        [
          { id: "a", type: "divider" },
          { id: "b", type: "divider" },
        ],
        [field],
        {},
      ).ok,
    ).toBe(false);
  });

  // "Not a divider" is the wrong question, and these are the two blocks that answer it wrongly: a
  // text block with no text, and a header with everything turned off. Both parse, both draw a blank
  // page, and both would consume a number from the template's sequence to attach it.
  // Only what NO value can rescue. A text block with nothing in it has nothing to resolve, whatever
  // arrives at the turn — while a header showing a logo, a hidden table, or a totals block asking
  // for a discount all DEPEND on the values, and those are settled exactly at issuance (see
  // document-draws.test.ts, which holds that answer against the renderer). Guessing at them here
  // refuses templates that are perfectly fine for the tenant that wrote them.
  test("refuses text blocks that can never resolve to anything", () => {
    expect(
      parseAuthoredTemplate([{ id: "t", type: "text", text: "" }], [field], {})
        .ok,
    ).toBe(false);
    expect(
      parseAuthoredTemplate(
        [{ id: "t", type: "text", text: "   \n  " }],
        [field],
        {},
      ).ok,
    ).toBe(false);
  });

  // The second of the two the comment above names, which was named and never asserted — and never
  // implemented either. A header whose logo and company are BOTH switched off and which carries no
  // title, subtitle or meta rows has nothing left to draw from, whatever arrives at the turn. It
  // saved, it could be granted, and then every preview and every issuance failed with
  // `documentWouldBeBlank`: a tool the agent owns and can never use, refused at the moment of use
  // rather than at the keyboard.
  test("refuses a header with every source of content switched off", () => {
    expect(
      parseAuthoredTemplate(
        [{ id: "h", type: "header", showLogo: false, showCompany: false }],
        [field],
        {},
      ).ok,
    ).toBe(false);
    // Whitespace counts as nothing, the same way it does in the exact check at issuance: the
    // renderer draws no glyph for it, so a title of one space is a blank page with extra steps.
    expect(
      parseAuthoredTemplate(
        [
          {
            id: "h",
            type: "header",
            showLogo: false,
            showCompany: false,
            title: "   ",
            subtitle: "",
          },
        ],
        [field],
        {},
      ).ok,
    ).toBe(false);
  });

  // The boundary, in all three directions, because each one is a value question and refusing it
  // would be this gate guessing at a turn it cannot see: the logo may exist, the company profile may
  // be filled in, and a title or a meta row prints on its own.
  test("accepts a header that switched off only part of itself", () => {
    const accepted = [
      { id: "h", type: "header", showCompany: false },
      { id: "h", type: "header", showLogo: false },
      {
        id: "h",
        type: "header",
        showLogo: false,
        showCompany: false,
        title: "Orçamento",
      },
      {
        id: "h",
        type: "header",
        showLogo: false,
        showCompany: false,
        subtitle: "Proposta comercial",
      },
      {
        id: "h",
        type: "header",
        showLogo: false,
        showCompany: false,
        meta: [{ label: "Validade", value: "7 dias" }],
      },
    ];
    for (const block of accepted) {
      expect(parseAuthoredTemplate([block], [field], {}).ok).toBe(true);
    }
  });

  // …and does NOT refuse the ones whose answer depends on values. A bare header is the letterhead
  // for a tenant that has one, a hidden table draws once an item arrives: refusing either here
  // would be this gate guessing at a turn it cannot see.
  test("accepts a layout whose output depends on the values", () => {
    expect(
      parseAuthoredTemplate([{ id: "h", type: "header" }], [field], {}).ok,
    ).toBe(true);
    expect(
      parseAuthoredTemplate(
        [{ id: "i", type: "lineItems", field: "itens", showHeader: false }],
        [{ name: "itens", label: "Itens", type: "lineItems" }],
        {},
      ).ok,
    ).toBe(true);
  });

  test("one printing block is enough, whichever it is", () => {
    for (const block of [
      { id: "h", type: "header", title: "Orçamento" },
      { id: "t", type: "text", text: "Olá." },
      {
        id: "f",
        type: "fields",
        rows: [{ label: "Cliente", value: "{{cliente}}" }],
      },
    ]) {
      expect(parseAuthoredTemplate([block], [field], {}).ok).toBe(true);
    }
  });

  // STORED content is read tolerantly, always: a row that somehow holds an empty layout still has
  // to load, or the operator cannot open it to fix it. That includes the AUTHORED path when the
  // caller did not send blocks — a wording-only or style-only patch must not be refused over a
  // layout it is not touching.
  test("a stored empty layout still reads, and a patch that leaves it alone still saves", () => {
    expect(parseTemplateContent([], [], {}).ok).toBe(true);
    expect(
      parseAuthoredTemplate([], [], {}, { blocks: false, fields: false }).ok,
    ).toBe(true);
  });
});

// Everything the page PRINTS has to be printable by the fonts that draw it, and the rule is
// checked where it was WRITTEN — not on the way out of storage, which belongs to whoever wrote it.
describe("authored text has to be printable", () => {
  test("refuses a block, a label and a footer that would be mangled", () => {
    const bad = parseAuthoredTemplate(
      [{ id: "t", type: "text", text: "Olá 中" }],
      [],
      {},
    );
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.reason).toContain("中");

    expect(
      parseAuthoredTemplate(
        [{ id: "t", type: "text", text: "ok" }],
        [{ name: "cliente", label: "Cliente 😀", type: "text" }],
        {},
      ).ok,
    ).toBe(false);
    expect(
      parseAuthoredTemplate([{ id: "t", type: "text", text: "ok" }], [], {
        footerText: "Obrigado 中",
      }).ok,
    ).toBe(false);
  });

  // Latin text with accents, curly quotes and a euro sign is the ordinary case, and it must not be
  // caught by a rule aimed at scripts the fonts cannot draw.
  test("ordinary Portuguese and punctuation pass", () => {
    expect(
      parseAuthoredTemplate(
        [{ id: "t", type: "text", text: "Orçamento — “à vista” € 1.299,90" }],
        [],
        {},
      ).ok,
    ).toBe(true);
  });

  // Nested rows are where an operator actually writes labels — "Validade", "Condições" — and they
  // were the half a key-by-key check missed. The collection walks the block instead of naming its
  // properties, so a row inside a header and a row inside a fields block are found the same way a
  // title is, and a block type added later is covered without a line.
  test("finds text nested inside a row, not just at the top of a block", () => {
    expect(
      parseAuthoredTemplate(
        [
          {
            id: "h",
            type: "header",
            title: "ok",
            meta: [{ label: "Validade 😀", value: "7 dias" }],
          },
        ],
        [],
        {},
      ).ok,
    ).toBe(false);
    expect(
      parseAuthoredTemplate(
        [
          {
            id: "f",
            type: "fields",
            rows: [{ label: "Cliente", value: "中" }],
          },
        ],
        [],
        {},
      ).ok,
    ).toBe(false);
  });

  // …and it does NOT trip over the keys that NAME things rather than print them. A block id is
  // never drawn — it exists so the console can edit one block's text by id — so an author writing
  // in their own script must not be refused over a value no reader will ever see. Refusing only
  // what the write actually changes is the rule; a check that cannot tell the two apart is a check
  // that invents failures.
  test("identifiers are not held to what the page can print", () => {
    expect(
      parseAuthoredTemplate(
        [
          { id: "项目", type: "lineItems", field: "itens" },
          { id: "t", type: "text", text: "ok", align: "center" },
        ],
        [{ name: "itens", label: "Itens", type: "lineItems" }],
        {},
      ).ok,
    ).toBe(true);
  });

  // A half the caller did NOT send belongs to storage: refusing it would make a template written by
  // a newer build impossible to edit rather than possible to fix.
  test("stored text is not held to it", () => {
    expect(
      parseAuthoredTemplate(
        [{ id: "t", type: "text", text: "Olá 中" }],
        [],
        {},
        { blocks: false },
      ).ok,
    ).toBe(true);
  });
});

// The contract a client authors against and the gate a write passes through have to be the same
// statement. Zod strips an unknown key; the write refuses it by name (see the authoring gate above),
// so a schema published without `additionalProperties: false` would promise a permissiveness no
// write honours — and the client would be refused by a document it had every reason to trust.
// Both halves of this feature key ordinary objects by a name the caller chose: values by field
// name, the console's wording edits by block id. On such an object those names are already taken.
describe("names that every object already has", () => {
  const items = { name: "cliente", label: "Cliente", type: "text" };

  // `values.constructor` answers with a function nobody stored, so an OPTIONAL field with this name,
  // omitted by the agent, arrives at validation as a function and the write fails on a value the
  // caller never sent.
  test("a field cannot be called constructor", () => {
    expect(
      parseAuthoredTemplate(
        [{ id: "t", type: "text", text: "ok" }],
        [{ ...items, name: "constructor" }],
        {},
      ).ok,
    ).toBe(false);
  });

  // Assigning to `__proto__` sets the prototype instead of creating a property, so the console
  // reports a saved wording edit it did not make. `toString` and `constructor` are read back as
  // inherited functions.
  test("a block id cannot be one either", () => {
    for (const id of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(
        parseAuthoredTemplate([{ id, type: "text", text: "ok" }], [items], {})
          .ok,
      ).toBe(false);
    }
  });

  // …and the ordinary names are untouched, including the lowercase spellings that only LOOK like
  // they collide: property names are case-sensitive, so `tostring` is nobody's property.
  test("ordinary names still pass", () => {
    for (const name of ["cliente", "tostring", "valueof", "prototype"]) {
      expect(
        parseAuthoredTemplate(
          [{ id: name, type: "text", text: "ok" }],
          [{ ...items, name }],
          {},
        ).ok,
      ).toBe(true);
    }
  });
});

describe("documentAuthoringSchema", () => {
  test("publishes every object as closed, nested rows included", () => {
    const schema = documentAuthoringSchema();
    const open: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => {
          walk(n, `${path}[${i}]`);
        });
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      if ("properties" in obj && obj.additionalProperties !== false) {
        open.push(path);
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    };
    walk(schema, "");
    expect(open).toEqual([]);
    // …and it does reach inside a block, not just the top of one.
    expect(JSON.stringify(schema.blocks)).toContain("additionalProperties");
  });

  // Closed is not the same as complete. A write takes a PARTIAL style — create fills the defaults,
  // update keeps the stored value — so publishing every property as required refuses a payload the
  // server accepts, and does it inside the client, where no server message can explain it.
  test("publishes the style as partial, the way a write takes it", () => {
    const style = documentAuthoringSchema().style as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(style.required ?? []).toEqual([]);
    // Every property is still published — optional, not absent.
    expect(Object.keys(style.properties).sort()).toEqual(
      Object.keys(documentStyleSchema.shape).sort(),
    );
    // And the gate really does take one property on its own.
    expect(
      authoredStyleProblem({ font: "serif" } as Record<string, unknown>),
    ).toBeNull();
  });
});

// Which day a document PRINTS. Two fields can answer, and only one of them is right for a customer
// east or west of UTC — the mistake is invisible in the bytes, so it is pinned here.
describe("printedDate", () => {
  test("prints the frozen day, not the UTC slice of the instant", () => {
    expect(
      printedDate({
        // 22:30 on the 5th in São Paulo, which is the 6th in UTC.
        issuedAt: "2026-09-06T01:30:00.000Z",
        issuedDate: "2026-09-05",
      }),
    ).toBe("2026-09-05");
  });

  // A row written before the frozen day existed was rendered from the slice; re-rendering it must
  // not silently move its date.
  test("falls back to the instant's day only when nothing was frozen", () => {
    expect(printedDate({ issuedAt: "2026-09-06T01:30:00.000Z" })).toBe(
      "2026-09-06",
    );
  });
});

// A starter's own prose promises these values: the quote's terms print "valid until" and the
// receipt's header prints the payment date. Optional, an omitted value renders that sentence with a
// blank after it — a document asking a question of its own reader.
describe("starters promise only what they require", () => {
  test("every field a starter's text prints is required", () => {
    for (const key of ["quote", "proposal", "receipt"] as const) {
      const starter = documentStarter(key, "pt-BR");
      if (!starter) throw new Error(`no starter: ${key}`);
      const printed = new Set(
        JSON.stringify(starter.blocks)
          .match(/\{\{\s*[a-z][a-z0-9_]*\s*\}\}/g)
          ?.map((m) => m.replace(/[{}\s]/g, "")) ?? [],
      );
      const optional = starter.fields
        .filter((f) => !f.required && printed.has(f.name))
        .map((f) => f.name);
      expect(optional).toEqual([]);
    }
  });
});

// The preview dates the DOCUMENT in a timezone and used to generate its sample dates from the UTC
// day, so a receipt previewed at 22:00 in São Paulo could say it was issued on the 22nd next to a
// sample payment date of the 23rd — the same off-by-a-day the issue path was fixed for, on the
// other side of the same page.
describe("sampleValues", () => {
  test("dates a sample from the day it is given, not from the instant", () => {
    const fields = [
      { name: "pago_em", label: "Pago em", type: "date" },
    ] as never;
    // 01:30 UTC on the 6th is 22:30 on the 5th in São Paulo.
    const at = new Date("2026-09-06T01:30:00.000Z");
    expect(sampleValues(fields, at, "2026-09-05").pago_em).toBe("2026-09-05");
    // With no day given it still falls back to the instant's, which is what a caller with no
    // timezone in hand can offer.
    expect(sampleValues(fields, at).pago_em).toBe("2026-09-06");
  });
});

// A STRUCTURAL KEY IS HELD TO A DIFFERENT RULE, NOT TO NONE.
//
// Block ids are excluded from the printable check on purpose: nothing draws them, so an emoji in one
// is harmless and refusing it would be a wall in front of an ordinary name. Storable is the OTHER
// question, and it was being asked of nothing here. The blocks land in a `jsonb` column and Postgres
// refuses a NUL or a lone surrogate there (measured against the dev server: casting a JSON object
// whose value spells the escape answers `unsupported Unicode escape sequence`). A preview writes
// nothing, so it rendered happily while create/update failed at the INSERT with a driver error, and
// an imported bundle took its whole transaction down with it.
describe("storable structural keys", () => {
  const text = { id: "corpo", type: "text", text: "Ola." };

  test("a block id the database cannot store is refused, naming the code point", () => {
    const r = parseAuthoredTemplate(
      [text, { id: `d${String.fromCodePoint(0)}`, type: "divider" }],
      [],
      undefined as never,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("U+0000");
  });

  test("half a character in a block id is refused too", () => {
    const r = parseAuthoredTemplate(
      [text, { id: `d${String.fromCharCode(0xd800)}`, type: "divider" }],
      [],
      undefined as never,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain("U+D800");
  });

  test("but an id in someone's own alphabet still passes", () => {
    // The half that makes this a STORABILITY rule and not a character-set one. An id is a name, and
    // an operator authoring through MCP writes it in the language they think in.
    const r = parseAuthoredTemplate(
      [
        text,
        { id: "secao", type: "divider" },
        { id: "\u0440\u0430\u0437\u0434\u0435\u043b", type: "divider" },
      ],
      [],
      undefined as never,
    );
    expect(r.ok).toBe(true);
  });
});
