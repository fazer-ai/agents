import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { DOCUMENT_STYLE_DEFAULTS } from "@/modules/documents/blocks";
import { documentDraws } from "@/modules/documents/draws";
import { renderDocumentPdf } from "@/modules/documents/render";
import type { CompanySettings } from "@/modules/tenant-settings/service";

// This rule restates the renderer's own conditions, and a restatement goes stale in silence. So it
// is checked AGAINST the renderer, in both directions: everything it calls blank really renders an
// empty page, and everything it calls drawn really puts something on one.
//
// The cases are the four review rounds' worth of conditionals that a template alone cannot answer:
// a text block that is only a token for an omitted field, a header showing a logo the tenant does
// not have, a totals block asking only for a discount that is zero, a hidden table with no items.

const EMPTY_COMPANY = {
  name: "",
  document: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoKey: null,
  logoVersion: 0,
} as CompanySettings;

const FILLED_COMPANY = { ...EMPTY_COMPANY, name: "ACME Ltda" };
const META = { number: "ORC-0001", date: "2026-08-20", title: "Orçamento" };

// What the PDF actually drew: the hex of every text run, plus whether an image was placed.
async function drawn(input: {
  blocks: unknown[];
  fields?: unknown[];
  values?: Record<string, unknown>;
  company?: CompanySettings;
  logo?: { data: Buffer; format: "png" | "jpg" } | null;
}): Promise<boolean> {
  const buf = await renderDocumentPdf({
    blocks: input.blocks,
    fields: input.fields ?? [],
    style: DOCUMENT_STYLE_DEFAULTS,
    values: input.values ?? {},
    company: input.company ?? EMPTY_COMPANY,
    logo: input.logo ?? null,
    meta: META,
  } as unknown as Parameters<typeof renderDocumentPdf>[0]);
  const raw = buf.toString("latin1");
  let inflated = "";
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endstream", start);
    try {
      inflated += inflateSync(
        Buffer.from(raw.slice(start, end), "latin1"),
      ).toString("latin1");
    } catch {
      // Not every stream is deflated; the ones that are not carry no drawing.
    }
  }
  // INK, not runs. An empty line is still drawn as a text run holding one space (the renderer keeps
  // a blank line's height that way), and a page whose only mark is a space is the blank page this
  // rule exists to catch — so the bytes are decoded and whitespace does not count. `Do` places an
  // XObject, which is how an image lands on the page.
  const marks = [...inflated.matchAll(/\[([^\]]*)\]\s*TJ/g)]
    .flatMap((arr) =>
      [...(arr[1] ?? "").matchAll(/<([0-9a-f]+)>/g)].map((x) => x[1] ?? ""),
    )
    .join("");
  const inked = (marks.match(/../g) ?? []).some((byte) => {
    const code = Number.parseInt(byte, 16);
    return code > 0x20 && code !== 0xa0;
  });
  return inked || / Do\b/.test(inflated);
}

const PNG = {
  data: Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
    0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
    0, 0, 0, 10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1,
    0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
    0x60, 0x82,
  ]),
  format: "png" as const,
};

const ITEMS_FIELD = { name: "itens", label: "Itens", type: "lineItems" };
const NOTES_FIELD = { name: "notas", label: "Notas", type: "text" };

const CASES: {
  name: string;
  blocks: unknown[];
  fields?: unknown[];
  values?: Record<string, unknown>;
  company?: CompanySettings;
  logo?: { data: Buffer; format: "png" | "jpg" } | null;
}[] = [
  {
    name: "a text block with words",
    blocks: [{ id: "t", type: "text", text: "Olá." }],
  },
  {
    name: "a text block that is only a token for an omitted field",
    blocks: [{ id: "t", type: "text", text: "{{notas}}" }],
    fields: [NOTES_FIELD],
  },
  {
    name: "…and the same block once that field has a value",
    blocks: [{ id: "t", type: "text", text: "{{notas}}" }],
    fields: [NOTES_FIELD],
    values: { notas: "sem juros" },
  },
  { name: "a divider on its own", blocks: [{ id: "d", type: "divider" }] },
  {
    name: "a header showing a logo the tenant does not have",
    blocks: [{ id: "h", type: "header" }],
  },
  {
    name: "…and the same header once there is a logo",
    blocks: [{ id: "h", type: "header" }],
    logo: PNG,
  },
  {
    name: "…and the same header once the company has a name",
    blocks: [{ id: "h", type: "header" }],
    company: FILLED_COMPANY,
  },
  {
    // A company field holding only whitespace. Both the API and the console accept it, and
    // `filter(Boolean)` used to count it as content — so a header-only document passed the gate,
    // took a number, and reached the customer as a blank page. The renderer draws no glyph for a
    // space, which is what makes this case a disagreement rather than a preference.
    name: "a header whose only company field is whitespace",
    blocks: [{ id: "h", type: "header" }],
    company: { ...EMPTY_COMPANY, name: "   " } as CompanySettings,
  },
  {
    name: "…and the same header once that field has a character in it",
    blocks: [{ id: "h", type: "header" }],
    company: { ...EMPTY_COMPANY, name: " A " } as CompanySettings,
  },
  {
    name: "a header with a title",
    blocks: [{ id: "h", type: "header", title: "Orçamento" }],
  },
  {
    name: "a totals block asking only for a discount that is zero",
    blocks: [{ id: "x", type: "totals", field: "itens", rows: ["discount"] }],
    fields: [ITEMS_FIELD],
    values: { itens: [{ description: "x", quantity: 1, unitPrice: 10 }] },
  },
  {
    name: "…and the same block once a discount was supplied",
    blocks: [
      {
        id: "x",
        type: "totals",
        field: "itens",
        rows: ["discount"],
        discountField: "desconto",
      },
    ],
    fields: [
      ITEMS_FIELD,
      { name: "desconto", label: "Desconto", type: "currency" },
    ],
    values: {
      itens: [{ description: "x", quantity: 1, unitPrice: 10 }],
      desconto: 2,
    },
  },
  {
    name: "a totals block that asks for the total",
    blocks: [{ id: "x", type: "totals", field: "itens", rows: ["total"] }],
    fields: [ITEMS_FIELD],
    values: {},
  },
  {
    name: "a hidden table with no items",
    blocks: [{ id: "i", type: "lineItems", field: "itens", showHeader: false }],
    fields: [ITEMS_FIELD],
  },
  {
    name: "…and the same table once an item arrives",
    blocks: [{ id: "i", type: "lineItems", field: "itens", showHeader: false }],
    fields: [ITEMS_FIELD],
    values: {
      itens: [{ description: "Instalação", quantity: 1, unitPrice: 10 }],
    },
  },
  {
    name: "a table showing its header",
    blocks: [{ id: "i", type: "lineItems", field: "itens" }],
    fields: [ITEMS_FIELD],
  },
  {
    name: "a fields block",
    blocks: [
      {
        id: "f",
        type: "fields",
        rows: [{ label: "Validade", value: "7 dias" }],
      },
    ],
  },
];

describe("documentDraws agrees with the renderer", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const answer = documentDraws({
        blocks: c.blocks,
        fields: c.fields ?? [],
        style: DOCUMENT_STYLE_DEFAULTS,
        values: (c.values ?? {}) as never,
        company: c.company ?? EMPTY_COMPANY,
        hasLogo: (c.logo ?? null) !== null,
        meta: META,
      } as unknown as Parameters<typeof documentDraws>[0]);
      expect(answer).toBe(await drawn(c));
    });
  }

  // …and the harness is looking at something: a case that draws and a case that does not have to
  // come out differently, or every assertion above passes for the wrong reason.
  test("the harness tells a drawn page from a blank one", async () => {
    expect(
      await drawn({ blocks: [{ id: "t", type: "text", text: "Olá." }] }),
    ).toBe(true);
    expect(await drawn({ blocks: [{ id: "d", type: "divider" }] })).toBe(false);
  });
});
