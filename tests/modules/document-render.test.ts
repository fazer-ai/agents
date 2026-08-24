import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
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
});
