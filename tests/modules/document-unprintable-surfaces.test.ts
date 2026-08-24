import { describe, expect, test } from "bun:test";
import { DOCUMENT_STYLE_DEFAULTS } from "@/modules/documents/blocks";
import { formatMoney } from "@/modules/documents/format";
import { unprintableCharacters } from "@/modules/documents/printable";
import {
  patchedContent,
  templateMetadataProblem,
} from "@/modules/documents/templates";
import {
  parseAuthoredTemplate,
  parseDocumentValues,
} from "@/modules/documents/validate";

// Every surface whose text reaches the PAGE, in one place.
//
// Three review rounds in a row found this same question answered in some places and not others: the
// text of a block, then a row nested inside one, then the number prefix, the template name, the
// currency symbol. Patching the site the round happened to name is what produced the next round, so
// the family is written down here instead — a row per surface, and adding a surface means adding a
// row rather than remembering that a rule exists.
//
// A surface is either GATED (the write refuses unprintable text, naming it) or SAFE BY
// CONSTRUCTION (nothing unprintable can reach it — a closed enum, digits, a formatter that falls
// back). Nothing may be neither, which is what "silently drawn as a different character" was.

const FIELDS = [
  { name: "cliente", label: "Cliente", type: "text" as const },
  { name: "itens", label: "Itens", type: "lineItems" as const },
];
const okBlock = { id: "t", type: "text", text: "ok" };

// Each row answers ONE question: does writing this surface with unprintable text get refused?
const GATED: [string, (bad: string) => boolean][] = [
  [
    "a text block",
    (bad) => !parseAuthoredTemplate([{ ...okBlock, text: bad }], [], {}).ok,
  ],
  [
    "a header's meta row",
    (bad) =>
      !parseAuthoredTemplate(
        [{ id: "h", type: "header", meta: [{ label: bad, value: "x" }] }],
        [],
        {},
      ).ok,
  ],
  [
    "a fields block's row",
    (bad) =>
      !parseAuthoredTemplate(
        [{ id: "f", type: "fields", rows: [{ label: "L", value: bad }] }],
        [],
        {},
      ).ok,
  ],
  [
    "a declared field's label",
    (bad) =>
      !parseAuthoredTemplate(
        [okBlock],
        [{ name: "cliente", label: bad, type: "text" }],
        {},
      ).ok,
  ],
  [
    "the footer",
    (bad) => !parseAuthoredTemplate([okBlock], [], { footerText: bad }).ok,
  ],
  [
    "the template name",
    (bad) => templateMetadataProblem({ name: bad }) !== null,
  ],
  [
    "the number prefix",
    (bad) => templateMetadataProblem({ numberPrefix: bad }) !== null,
  ],
  [
    "a value the model writes",
    (bad) => !parseDocumentValues(FIELDS, { cliente: bad, itens: [] }).ok,
  ],
  [
    "a line item's description",
    (bad) =>
      !parseDocumentValues(FIELDS, {
        cliente: "Ana",
        itens: [{ description: bad, quantity: 1, unitPrice: 1 }],
      }).ok,
  ],
];

describe("every surface that prints refuses what cannot be printed", () => {
  // Two shapes of offender: one outside the BMP (a surrogate pair, where BOTH code units are
  // unmapped) and one inside it. They take different paths through the encoder.
  for (const bad of ["😀", "中"]) {
    for (const [surface, refuses] of GATED) {
      test(`${surface} refuses ${bad}`, () => {
        expect(refuses(bad)).toBe(true);
      });
    }
  }
});

// …and the WRITE PATHS that reach those surfaces, which is a different question from whether the
// validator has the rule. A decision table over `parseAuthoredTemplate` proves the FUNCTION; it does
// not prove that the paths a caller actually uses ask it. Both holes found in review were exactly
// that: `blockText` (the console's ordinary save) and a partial `style` patch each leave their
// authored-half flag FALSE, so the rule they pass through never looked at what the caller typed.
describe("the write paths ask, not just the validator", () => {
  const bad = "😀";

  test("a blockText patch is caller text, whatever the blocks flag says", () => {
    expect(() =>
      patchedContent(
        { blocks: [{ id: "t", type: "text", text: "ok" }], fields: [] },
        { blockText: { t: `Olá ${bad}` } },
      ),
    ).toThrow(/blockText/);
  });

  test("a partial style patch is caller text too", () => {
    expect(() =>
      patchedContent(
        { blocks: [{ id: "t", type: "text", text: "ok" }], fields: [] },
        { style: { footerText: `Obrigado ${bad}` } },
      ),
    ).toThrow(/footerText/);
  });

  // …and neither refuses what the caller did NOT write: a stored value from a newer build has to
  // stay editable, which is the reason those flags exist in the first place.
  test("the same patch over stored text a newer build wrote still saves", () => {
    expect(() =>
      patchedContent(
        {
          blocks: [{ id: "t", type: "text", text: `de outro build ${bad}` }],
          fields: [],
          style: { footerText: `rodapé ${bad}` },
        },
        { blockText: { t: "texto novo" } },
      ),
    ).not.toThrow();
  });
});

// Control characters are their own half of "cannot print", and they split the two kinds of surface
// apart rather than joining them.
describe("control characters", () => {
  const NUL = String.fromCharCode(0);
  const BELL = String.fromCharCode(7);
  const CR = String.fromCharCode(13);

  // AUTHORED text is refused. Nothing sanitises a block on the way to the page, so a control there
  // is drawn as an empty box at the end of every line — and a NUL never even gets that far, because
  // Postgres refuses it in text and jsonb, turning an authored template into a 500 at the INSERT
  // instead of a refusal anyone can act on.
  test("are refused in authored text, by code point", () => {
    for (const ch of [NUL, BELL, CR]) {
      const r = parseAuthoredTemplate(
        [{ ...okBlock, text: `ok${ch}` }],
        [],
        {},
      );
      expect(r.ok).toBe(false);
      // Named U+XXXX: a control has no shape to quote, and pasting one into the message would put
      // it into a log line and an API response.
      expect(r.ok ? "" : r.reason).toMatch(/U\+00(00|07|0D)/);
    }
  });

  // …and a LINE FEED is not one of them: a text block is legitimately several lines.
  test("a line feed is text, not a control", () => {
    expect(
      parseAuthoredTemplate([{ ...okBlock, text: "primeira\nsegunda" }], [], {})
        .ok,
    ).toBe(true);
  });

  // VALUES are normalised instead, because that is what already reaches the page: `resolveTokens`
  // sanitises every substitution, so a model's stray tab or bell becomes a space by design. Checking
  // the raw string would refuse text this project has decided to accept and print.
  test("are normalised in values, not refused", () => {
    const r = parseDocumentValues(FIELDS, {
      cliente: `Ana${BELL}${CR}`,
      itens: [{ description: `Serviço${NUL}`, quantity: 1, unitPrice: 1 }],
    });
    expect(r.ok).toBe(true);
  });
});

// The surfaces nobody authors, which is why they cannot be gated at a write.
describe("what is printable by construction", () => {
  // The currency SYMBOL is chosen by Intl from a valid code. INR, KRW, THB, VND and ILS are real
  // codes whose symbols the standard 14 fonts cannot encode, so the formatter falls back to the
  // code — the only place that knows what the symbol turned out to be.
  test("a valid code with an unprintable symbol falls back to the code", () => {
    for (const currency of ["INR", "KRW", "THB", "VND", "ILS"]) {
      const out = formatMoney(1299.9, "pt-BR", currency);
      expect(unprintableCharacters(out)).toEqual([]);
      expect(out).toContain(currency);
    }
  });

  // …and the ones that DO encode keep their symbol: a fallback that fires everywhere would print
  // "1299,90 BRL" on every Brazilian document, which is the output this formatter exists to avoid.
  test("a printable symbol is kept", () => {
    for (const [currency, symbol] of [
      ["BRL", "R$"],
      ["EUR", "€"],
      ["GBP", "£"],
      ["USD", "US$"],
    ] as const) {
      const out = formatMoney(1299.9, "pt-BR", currency);
      expect(out).toContain(symbol);
      expect(unprintableCharacters(out)).toEqual([]);
    }
  });

  // The date comes from a closed locale set, and the number from digits and a prefix that is gated
  // above — both are printable for every input they can take.
  test("dates and amounts carry nothing unprintable", () => {
    for (const locale of ["pt-BR", "en-US"] as const) {
      const style = { ...DOCUMENT_STYLE_DEFAULTS, locale };
      expect(
        unprintableCharacters(formatMoney(0, style.locale, style.currency)),
      ).toEqual([]);
    }
  });
});
