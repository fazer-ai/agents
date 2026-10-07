import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { getDocumentProxy } from "unpdf";
import {
  DOCUMENT_FONTS,
  DOCUMENT_STYLE_DEFAULTS,
  type DocumentStyle,
} from "@/modules/documents/blocks";
import type { CompanyLogo } from "@/modules/documents/company";
import {
  FOOTER_MAX_LINES,
  footerReserve,
  renderDocumentPdf,
} from "@/modules/documents/render";
import { sampleValues } from "@/modules/documents/sample";
import { documentStarters } from "@/modules/documents/starters";
import { parseTemplateContent } from "@/modules/documents/validate";

// The renderer produces bytes for every combination the style offers, and it does so without
// reaching the network or the filesystem.
//
// The font rows are the ones with history behind them: the renderer this replaced avoided
// Font.register precisely because a bundled face resolves from a path that differs between the dev
// tree and the container. Using the built-in families removes the path entirely, and the CWD row
// below is what proves that claim rather than asserting it in a comment.

const META = { number: "ORC-0001", date: "05/09/2026", title: "Orçamento" };

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

// The text the page actually DRAWS, decoded out of the content streams. Assertions about clipping
// cannot read the input string — the whole question is what survived layout.
function drawnText(buf: Buffer): string {
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
  const hex = [...inflated.matchAll(/\[([^\]]*)\]\s*TJ/g)]
    .flatMap((arr) =>
      [...(arr[1] ?? "").matchAll(/<([0-9a-f]+)>/g)].map((x) => x[1] ?? ""),
    )
    .join("");
  // The built-in faces encode as one byte per character for Latin text.
  return (hex.match(/../g) ?? [])
    .map((b) => String.fromCharCode(Number.parseInt(b, 16)))
    .join("");
}

// A 1x1 PNG, inline, so the test never touches the filesystem for it.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function starterInput(style?: Partial<DocumentStyle>) {
  const starter = documentStarters("pt-BR")[0];
  if (!starter) throw new Error("no starter");
  const parsed = parseTemplateContent(starter.blocks, starter.fields, {});
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    blocks: parsed.content.blocks,
    fields: parsed.content.fields,
    style: { ...starter.style, ...style },
    values: sampleValues(
      parsed.content.fields,
      new Date("2026-09-05T12:00:00Z"),
    ),
    company: COMPANY,
    meta: META,
  };
}

describe("renderDocumentPdf", () => {
  test("renders with every font family the style offers", async () => {
    for (const font of DOCUMENT_FONTS) {
      const bytes = await renderDocumentPdf(starterInput({ font }));
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.byteLength).toBeGreaterThan(500);
    }
  });

  // The failure the old renderer's header was written to avoid: a face that resolves relative to the
  // process's working directory renders in the dev tree and not in the container, where the app is
  // started from /app. Running the same render from a different CWD is what actually tests it.
  test("renders from a working directory other than the repo root", async () => {
    const original = process.cwd();
    try {
      process.chdir("/");
      const bytes = await renderDocumentPdf(starterInput());
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    } finally {
      process.chdir(original);
    }
  });

  test("renders both page sizes, both locales and every margin", async () => {
    for (const pageSize of ["A4", "LETTER"] as const) {
      for (const locale of ["pt-BR", "en-US"] as const) {
        for (const margin of ["narrow", "normal", "wide"] as const) {
          const bytes = await renderDocumentPdf(
            starterInput({ pageSize, locale, margin }),
          );
          expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
        }
      }
    }
  });

  // The logo arrives as BYTES, never as a URL: @react-pdf will fetch an <Image src> over the
  // network, which on a server renderer is a request driven by tenant input.
  test("draws a logo supplied as bytes", async () => {
    const logo: CompanyLogo = { data: PNG, format: "png" };
    const withLogo = await renderDocumentPdf({
      ...starterInput(),
      company: { ...COMPANY, logoKey: "1-logo.png" },
      logo,
    });
    expect(withLogo.subarray(0, 5).toString()).toBe("%PDF-");
  });

  // A tenant whose storage volume did not come back still has to receive their document.
  test("renders without a logo rather than failing the document", async () => {
    const bytes = await renderDocumentPdf({ ...starterInput(), logo: null });
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("renders an empty document and a document with no values", async () => {
    const empty = await renderDocumentPdf({
      blocks: [],
      fields: [],
      style: DOCUMENT_STYLE_DEFAULTS,
      values: {},
      company: COMPANY,
      meta: META,
    });
    expect(empty.subarray(0, 5).toString()).toBe("%PDF-");
    const noValues = await renderDocumentPdf({ ...starterInput(), values: {} });
    expect(noValues.subarray(0, 5).toString()).toBe("%PDF-");
  });

  // Two renders of the same input must produce the same document: the snapshot on an issued row is
  // only worth freezing if replaying it lands in the same place.
  test("is deterministic for the same input", async () => {
    const input = starterInput();
    const a = await renderDocumentPdf(input);
    const b = await renderDocumentPdf(input);
    expect(a.byteLength).toBe(b.byteLength);
  });

  test("renders every starter, in both languages", async () => {
    for (const locale of ["pt-BR", "en-US"] as const) {
      for (const starter of documentStarters(locale)) {
        const parsed = parseTemplateContent(starter.blocks, starter.fields, {});
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) continue;
        const bytes = await renderDocumentPdf({
          blocks: parsed.content.blocks,
          fields: parsed.content.fields,
          style: starter.style,
          values: sampleValues(
            parsed.content.fields,
            new Date("2026-09-05T12:00:00Z"),
          ),
          company: COMPANY,
          meta: META,
        });
        expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      }
    }
  });
});

// The footer is absolutely positioned and `fixed`, so it is outside the flow: the page reserves the
// space it will occupy, or it draws on top of the last rows of the body, on every page.
//
// The reserve and the render have to answer the SAME question. They did not: the space was reserved
// for page numbers, while the footer renders whenever there is footer text OR page numbers, so a
// letterhead footer with no page numbers — the ordinary case — overlapped the body.
describe("footerReserve", () => {
  const style = (over: Partial<DocumentStyle>): DocumentStyle => ({
    ...DOCUMENT_STYLE_DEFAULTS,
    ...over,
  });

  test("reserves nothing when no footer is drawn", () => {
    expect(
      footerReserve(style({ footerText: undefined, showPageNumbers: false })),
    ).toBe(0);
  });

  test("reserves for a footer that is only text", () => {
    expect(
      footerReserve(style({ footerText: "Obrigado!", showPageNumbers: false })),
    ).toBeGreaterThan(0);
  });

  test("reserves for page numbers, and for both together", () => {
    const numbers = footerReserve(
      style({ footerText: undefined, showPageNumbers: true }),
    );
    expect(numbers).toBeGreaterThan(0);
    expect(
      footerReserve(style({ footerText: "x", showPageNumbers: true })),
    ).toBe(numbers);
  });

  // The reserve is a fixed number of lines, so it is only a BOUND if the footer cannot draw more of
  // them. The authored string is capped, but a `{{token}}` in it resolves at issuance to whatever
  // the field holds — so the drawn footer is clipped to the same number of lines.
  test("a footer whose token expands is clipped, not wrapped past the reserve", async () => {
    // A document whose only text is the footer, so what comes back is the footer and nothing else.
    // The value arrives through a declared FIELD, which is the path that makes the drawn footer
    // unbounded: the authored string is capped, what a token resolves to is not.
    const long = Array.from({ length: 60 }, (_, i) => `palavra${i}`).join(" ");
    const buf = await renderDocumentPdf({
      blocks: [{ id: "d", type: "divider" }],
      fields: [{ name: "nota", label: "Nota", type: "text" }],
      values: { nota: long },
      style: { ...DOCUMENT_STYLE_DEFAULTS, footerText: "{{nota}}" },
      company: { ...COMPANY, name: "", document: "", address: "" },
      meta: META,
      logo: null,
    } as unknown as Parameters<typeof renderDocumentPdf>[0]);
    const text = drawnText(buf);
    expect(text).toContain("palavra0");
    // Two lines' worth at this size is about 26 words, so the tail has to be gone.
    expect(text).not.toContain("palavra59");
    expect(FOOTER_MAX_LINES).toBe(2);
  });

  // …and with a page number beside it, which is what the footer text's flex basis is for: measured
  // at its intrinsic width, a long footer takes the whole row and pushes the number off the page.
  test("a long footer leaves the page number its place", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `palavra${i}`).join(" ");
    const buf = await renderDocumentPdf({
      blocks: [{ id: "d", type: "divider" }],
      fields: [{ name: "nota", label: "Nota", type: "text" }],
      values: { nota: long },
      style: {
        ...DOCUMENT_STYLE_DEFAULTS,
        footerText: "{{nota}}",
        showPageNumbers: true,
      },
      company: { ...COMPANY, name: "", document: "", address: "" },
      meta: META,
      logo: null,
    } as unknown as Parameters<typeof renderDocumentPdf>[0]);
    const text = drawnText(buf);
    expect(text).toContain("palavra0");
    expect(text).toContain("1/1");
  });
  // The header carries a logo, a multiline company block, a document number and free-form meta.
  // Whatever their lengths, no two drawn strings may share space and none leaves the page: the
  // cases below are the ones a narrow column used to get wrong.
  test("no header text overlaps another or leaves the page", async () => {
    const cases = [
      {
        name: "long meta value",
        number: "ORC-0001",
        label: "Nome do cliente",
        value: "Associação dos Moradores de São João do Rio Preto",
      },
      {
        name: "long meta label",
        number: "ORC-0001",
        label: "Nome completo do cliente solicitante",
        value: "Associação dos Moradores de São João do Rio Preto",
      },
      {
        name: "long unbroken meta value",
        number: "ORC-0001",
        label: "E-mail",
        value: "administracao.financeira@associacaodosmoradoresdobairro.com.br",
      },
      {
        name: "long document number",
        number: "2026-ORCAMENTO-0001",
        label: "Cliente",
        value: "Maria",
      },
    ];
    for (const c of cases) {
      for (const margin of ["normal", "wide"] as const) {
        const parsed = parseTemplateContent(
          [
            {
              id: "header",
              type: "header",
              title: "{{doc_title}} {{doc_number}}",
              meta: [
                { label: c.label, value: c.value },
                { label: "Validade", value: "05/10/2026" },
              ],
            },
          ],
          [],
          {},
        );
        if (!parsed.ok) throw new Error(parsed.reason);
        const bytes = await renderDocumentPdf({
          blocks: parsed.content.blocks,
          fields: [],
          style: { ...DOCUMENT_STYLE_DEFAULTS, margin },
          values: {},
          company: {
            ...COMPANY,
            address:
              "Rua das Acácias, 120, Sala 4 · Jardim Paulista · São Paulo, SP",
            logoKey: "1-logo.png",
          },
          logo: { data: PNG, format: "png" },
          meta: { ...META, number: c.number },
        });
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        const page = await pdf.getPage(1);
        const [left, , right] = page.view as number[];
        const boxes = (
          (await page.getTextContent()).items.filter(
            (item) => "str" in item && "transform" in item,
          ) as {
            str: string;
            transform: number[];
            width: number;
            height: number;
          }[]
        )
          .filter((item) => item.str.trim() !== "")
          .map((item) => ({
            str: item.str,
            x0: item.transform[4] ?? 0,
            x1: (item.transform[4] ?? 0) + item.width,
            y0: item.transform[5] ?? 0,
            y1: (item.transform[5] ?? 0) + item.height,
          }));
        const where = `${c.name}/${margin}`;
        for (const b of boxes) {
          expect(
            `${where}:${b.str}:${b.x0 >= (left ?? 0) && b.x1 <= (right ?? 0)}`,
          ).toBe(`${where}:${b.str}:true`);
        }
        for (const [i, a] of boxes.entries()) {
          for (const b of boxes.slice(i + 1)) {
            const overlap =
              Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 &&
              Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;
            expect(`${where}:${a.str} / ${b.str}:${overlap}`).toBe(
              `${where}:${a.str} / ${b.str}:false`,
            );
          }
        }
      }
    }
  });

  // A document number is printed as issued: the header may wrap it, but never at a hyphen of its
  // own making, which would print a different identifier.
  test("the header never hyphenates a document number", async () => {
    const titles = [
      "Orçamento",
      "Orçamento de prestação de serviços",
      "Proposta comercial de instalação elétrica residencial",
      "Recibo de pagamento de serviços prestados no mês",
    ];
    const numbers = [
      { number: "2026-ORCAMENTO-0001", baseFontSize: 10 },
      { number: "ORCAMENTOSERVICO2026-0001", baseFontSize: 14 },
    ];
    for (const title of titles) {
      for (const { number, baseFontSize } of numbers) {
        for (const margin of ["narrow", "normal", "wide"] as const) {
          const parsed = parseTemplateContent(
            [
              {
                id: "header",
                type: "header",
                title: "{{doc_title}} {{doc_number}}",
                meta: [
                  { label: "Referência", value: `${title} {{doc_number}}` },
                ],
              },
            ],
            [],
            {},
          );
          if (!parsed.ok) throw new Error(parsed.reason);
          const bytes = await renderDocumentPdf({
            blocks: parsed.content.blocks,
            fields: [],
            style: { ...DOCUMENT_STYLE_DEFAULTS, margin, baseFontSize },
            values: {},
            company: { ...COMPANY, logoKey: "1-logo.png" },
            logo: { data: PNG, format: "png" },
            meta: { ...META, title, number },
          });
          const pdf = await getDocumentProxy(new Uint8Array(bytes));
          const page = await pdf.getPage(1);
          const drawn = (await page.getTextContent()).items
            .filter((item) => "str" in item)
            .map((item) => (item as { str: string }).str)
            .join("");
          expect(
            `${title}/${number}/${margin}:${drawn.split(number).length - 1}`,
          ).toBe(`${title}/${number}/${margin}:2`);
        }
      }
    }
  });

  // A string with no space and wider than any line still prints every character: losing the end of
  // a URL or a token is worse than the hyphen the renderer draws where it has to break it.
  test("an unbroken header string wider than the line keeps every character", async () => {
    const cases = [
      { token: "abcdefghij".repeat(20), style: DOCUMENT_STYLE_DEFAULTS },
      { token: "1".repeat(120), style: DOCUMENT_STYLE_DEFAULTS },
      // Fits the line in regular weight, not in the bold the title is drawn in.
      { token: "b".repeat(44), style: DOCUMENT_STYLE_DEFAULTS },
      {
        token: `https://exemplo.com.br/${"a1b2c3".repeat(15)}`,
        style: DOCUMENT_STYLE_DEFAULTS,
      },
      {
        token: `${"M".repeat(25)}-0001`,
        style: { ...DOCUMENT_STYLE_DEFAULTS, baseFontSize: 14, margin: "wide" },
      },
      {
        token: "1".repeat(40),
        style: {
          ...DOCUMENT_STYLE_DEFAULTS,
          font: "mono",
          baseFontSize: 14,
          margin: "narrow",
        },
      },
    ] as const;
    for (const { token, style } of cases) {
      const parsed = parseTemplateContent(
        [
          {
            id: "header",
            type: "header",
            title: token,
            meta: [{ label: "Link", value: token }],
          },
        ],
        [],
        {},
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      const bytes = await renderDocumentPdf({
        blocks: parsed.content.blocks,
        fields: [],
        style,
        values: {},
        company: COMPANY,
        meta: META,
      });
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const page = await pdf.getPage(1);
      const items = (await page.getTextContent()).items.filter(
        (item) => "str" in item && "transform" in item,
      ) as { str: string; transform: number[]; width: number }[];
      // Inside the margin, not just the page: a line that runs into the margin is already wider than
      // the one the layout reserved.
      const [, , right] = page.view as number[];
      const margin = { narrow: 28, normal: 42, wide: 60 }[style.margin];
      for (const item of items) {
        expect(
          `${token}:${(item.transform[4] ?? 0) + item.width <= (right ?? 0) - margin + 0.5}`,
        ).toBe(`${token}:true`);
      }
      const drawn = items
        .map((item) => item.str)
        .join("")
        .replaceAll("-", "");
      const whole = token.replaceAll("-", "");
      expect(`${token}:${drawn.split(whole).length - 1}`).toBe(`${token}:2`);
    }
  });

  // The company block is header text too: a name with no space wider than the letterhead breaks
  // inside the margin and keeps every character, with and without a logo beside it.
  test("a company name wider than the letterhead keeps every character", async () => {
    // 17 is wider than the full line; 13 fits it, but not the width the logo leaves.
    for (const [name, withLogo] of [
      ["ACME".repeat(17), false],
      ["ACME".repeat(17), true],
      ["ACME".repeat(13), true],
    ] as const) {
      const parsed = parseTemplateContent(
        [{ id: "header", type: "header", title: "Orçamento" }],
        [],
        {},
      );
      if (!parsed.ok) throw new Error(parsed.reason);
      const bytes = await renderDocumentPdf({
        blocks: parsed.content.blocks,
        fields: [],
        style: { ...DOCUMENT_STYLE_DEFAULTS, margin: "wide" },
        values: {},
        company: {
          ...COMPANY,
          name,
          address: "RUAS".repeat(20),
          ...(withLogo ? { logoKey: "1-logo.png" } : {}),
        },
        ...(withLogo ? { logo: { data: PNG, format: "png" as const } } : {}),
        meta: META,
      });
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const page = await pdf.getPage(1);
      const items = (await page.getTextContent()).items.filter(
        (item) => "str" in item && "transform" in item,
      ) as { str: string; transform: number[]; width: number }[];
      const [, , right] = page.view as number[];
      for (const item of items) {
        expect(
          `${withLogo}:${item.str}:${(item.transform[4] ?? 0) + item.width <= (right ?? 0) - 60 + 0.5}`,
        ).toBe(`${withLogo}:${item.str}:true`);
      }
      const drawn = items
        .map((item) => item.str)
        .join("")
        .replaceAll("-", "");
      expect(`${withLogo}:${drawn.includes(name)}`).toBe(`${withLogo}:true`);
      expect(`${withLogo}:${drawn.includes("RUAS".repeat(20))}`).toBe(
        `${withLogo}:true`,
      );
    }
  });

  // Labels print in small capitals, but only a character whose capital the built-in fonts can draw
  // is raised: "µ" stays "µ" rather than becoming a Greek "Μ" the page cannot encode.
  test("a label is raised to capitals only where the capital prints", async () => {
    const parsed = parseTemplateContent(
      [
        {
          id: "header",
          type: "header",
          title: "Orçamento",
          meta: [{ label: "Espessura (µm)", value: "12" }],
        },
        {
          id: "specs",
          type: "fields",
          rows: [{ label: "Tolerância (µm)", value: "0,5" }],
        },
      ],
      [],
      {},
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    const bytes = await renderDocumentPdf({
      blocks: parsed.content.blocks,
      fields: [],
      style: DOCUMENT_STYLE_DEFAULTS,
      values: {},
      company: COMPANY,
      meta: META,
    });
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const page = await pdf.getPage(1);
    const drawn = (await page.getTextContent()).items
      .filter((item) => "str" in item)
      .map((item) => (item as { str: string }).str)
      .join("")
      // The extractor names the Latin-1 micro sign by its glyph, the Greek mu.
      .replaceAll("\u03bc", "\u00b5");
    expect(drawn).toContain("ESPESSURA (µM)");
    expect(drawn).toContain("TOLERÂNCIA (µM)");
  });

  // The footer text and the page number share one row: a long footer wraps in what the number
  // leaves, and never runs under it.
  test("a long footer wraps beside the page number instead of under it", async () => {
    const starter = documentStarters("pt-BR")[0];
    if (!starter) throw new Error("no starter");
    const parsed = parseTemplateContent(starter.blocks, starter.fields, {});
    if (!parsed.ok) throw new Error(parsed.reason);
    const bytes = await renderDocumentPdf({
      blocks: parsed.content.blocks,
      fields: parsed.content.fields,
      style: starter.style,
      values: sampleValues(
        parsed.content.fields,
        new Date("2026-09-05T12:00:00Z"),
      ),
      company: {
        ...COMPANY,
        name: "Associação Comunitária dos Moradores, Produtores Rurais e Comerciantes do Bairro de São João do Rio Preto e Adjacências",
      },
      meta: META,
    });
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const page = await pdf.getPage(1);
    const items = (await page.getTextContent()).items.filter(
      (item) => "str" in item && "transform" in item,
    ) as { str: string; transform: number[]; width: number }[];
    const number = items.find((item) => item.str.startsWith("Página"));
    if (!number) throw new Error("page number not drawn");
    const numberY = number.transform[5] ?? 0;
    const numberX = number.transform[4] ?? 0;
    const beside = items.filter(
      (item) =>
        item !== number &&
        item.str.trim() !== "" &&
        Math.abs((item.transform[5] ?? 0) - numberY) < 1,
    );
    expect(beside.length).toBeGreaterThan(0);
    for (const item of beside) {
      expect((item.transform[4] ?? 0) + item.width).toBeLessThanOrEqual(
        numberX + 0.5,
      );
    }
  });

  // Every starter carries a footer, and the default style numbers its pages: both have to land INSIDE
  // the page, on the starter's own body. A line height that reaches the fixed footer still draws it,
  // below the page's bottom edge, where no reader sees it.
  test("every starter draws its footer and page number on the page", async () => {
    for (const locale of ["pt-BR", "en-US"] as const) {
      for (const starter of documentStarters(locale)) {
        const parsed = parseTemplateContent(starter.blocks, starter.fields, {});
        if (!parsed.ok) throw new Error(parsed.reason);
        const bytes = await renderDocumentPdf({
          blocks: parsed.content.blocks,
          fields: parsed.content.fields,
          style: starter.style,
          values: sampleValues(
            parsed.content.fields,
            new Date("2026-09-05T12:00:00Z"),
          ),
          company: COMPANY,
          meta: META,
        });
        const pdf = await getDocumentProxy(new Uint8Array(bytes));
        const page = await pdf.getPage(1);
        const [, bottom, , top] = page.view as number[];
        const onPage = (await page.getTextContent()).items
          .filter((item) => "str" in item && "transform" in item)
          .filter((item) => {
            const y = (item as { transform: number[] }).transform[5] ?? -1;
            return y >= (bottom ?? 0) && y <= (top ?? 0);
          })
          .map((item) => (item as { str: string }).str)
          .join("|");
        const pageLabel = locale === "pt-BR" ? "Página 1/1" : "Page 1/1";
        expect(`${starter.key}:${onPage.includes(pageLabel)}`).toBe(
          `${starter.key}:true`,
        );
        if (starter.style.footerText) {
          expect(
            `${starter.key}:${onPage.includes(`${COMPANY.name} · ${META.number}`)}`,
          ).toBe(`${starter.key}:true`);
        }
      }
    }
  });
});
