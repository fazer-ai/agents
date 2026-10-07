import {
  Document,
  Image,
  Page,
  renderToBuffer,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import PDFDocument from "pdfkit";
import type { CompanySettings } from "@/modules/tenant-settings/service";
import {
  type DocumentBlock,
  type DocumentField,
  type DocumentStyle,
  LINE_ITEM_COLUMNS,
  type LineItemColumn,
  type TotalRow,
} from "./blocks";
import { formatMoney, formatNumber } from "./format";
import { type InlineSpan, parseSimpleMarkdown } from "./markdown";
import { printableUpperCase } from "./printable";
import { resolveFooterText, resolveTokens } from "./tokens";
import { computeTotals, lineTotal } from "./totals";
import type { DocumentValues, LineItemValue } from "./validate";
import { buildDocumentVars, type DocumentMeta } from "./vars";

// Blocks + resolved values → PDF bytes. Pure in the sense that matters: it takes data that is
// already resolved and bounded and returns bytes, so the caller renders OUTSIDE any transaction
// (this is CPU-bound) and the renderer never reaches the network.
//
// The logo arrives as BYTES, never as a URL. @react-pdf/renderer will happily fetch an <Image src>
// over the network, which on a server renderer is a server-side request driven by tenant input — the
// SSRF shape. Reading the file ourselves, from a path built out of numeric ids, is what keeps the
// renderer offline.

// The standard 14 fonts @react-pdf ships. No Font.register: a bundled TTF is megabytes in a public
// repo and resolves from a path that differs between the dev tree and the container, and the
// registry it goes into is global and does not deduplicate, so registering per render leaks. These
// three cover Latin-1, which is what PT-BR needs.
const FONT_FAMILY: Record<DocumentStyle["font"], string> = {
  sans: "Helvetica",
  serif: "Times-Roman",
  mono: "Courier",
};

const MARGIN: Record<DocumentStyle["margin"], number> = {
  narrow: 28,
  normal: 42,
  wide: 60,
};

// The footer is an absolutely-positioned `fixed` element outside the flow, so the page reserves its
// space by the same condition that decides whether it renders. A `{{token}}` can make the drawn
// footer arbitrarily long, so it is clipped to the lines reserved here.
export const FOOTER_MAX_LINES = 2;

export function footerReserve(style: DocumentStyle): number {
  if (!style.footerText && !style.showPageNumbers) return 0;
  return FOOTER_MAX_LINES * Math.round((style.baseFontSize - 2) * 1.4);
}

// The header prints the document's title, number and meta values, which are identifiers as often as
// words, and labels print in spaced capitals wider than what was typed. A word that fits a full line is never given a break point, because the line breaker would
// use one (and draw a hyphen) to fill a line rather than move the word down. A word wider than any
// line gets one every few characters, since the renderer drops whatever a line cannot hold. The width
// is measured by the same engine, in the same built-in font, the page is drawn with.
const PAGE_WIDTH: Record<DocumentStyle["pageSize"], number> = {
  A4: 595.28,
  LETTER: 612,
};

const BOLD_FONT: Record<DocumentStyle["font"], string> = {
  sans: "Helvetica-Bold",
  serif: "Times-Bold",
  mono: "Courier-Bold",
};

const measurer = new PDFDocument({ autoFirstPage: false });

function headerBreaks(
  font: string,
  fontSize: number,
  lineWidth: number,
  letterSpacing = 0,
) {
  return (word: string) =>
    measurer.font(font).fontSize(fontSize).widthOfString(word) +
      letterSpacing * [...word].length <=
    lineWidth
      ? [word]
      : (word.match(/.{1,12}/gsu) ?? [word]);
}

const LABEL_SPACING = 0.4;

const SPACE_AFTER: Record<"none" | "sm" | "md" | "lg", number> = {
  none: 0,
  sm: 6,
  md: 12,
  lg: 24,
};

const LABELS = {
  "pt-BR": {
    description: "Descrição",
    quantity: "Qtd",
    unitPrice: "Valor unit.",
    total: "Total",
    subtotal: "Subtotal",
    discount: "Desconto",
    tax: "Acréscimos",
    grandTotal: "Total",
    page: "Página",
  },
  "en-US": {
    description: "Description",
    quantity: "Qty",
    unitPrice: "Unit price",
    total: "Total",
    subtotal: "Subtotal",
    discount: "Discount",
    tax: "Tax",
    grandTotal: "Total",
    page: "Page",
  },
} as const;

const COLUMN_FLEX: Record<LineItemColumn, number> = {
  description: 5,
  quantity: 1,
  unitPrice: 2,
  total: 2,
};

export interface DocumentRenderInput {
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
  values: DocumentValues;
  company: CompanySettings;
  meta: DocumentMeta;
  // Already read off disk by the caller. `format` is what @react-pdf needs to decode it, and the
  // upload path is what restricts it to the two formats the renderer can actually decode.
  logo?: { data: Buffer; format: "png" | "jpg" } | null;
}

/** `#rrggbb` mixed toward white by `amount` (0..1): the table head's fill, derived from the accent. */
export function tint(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) return "#f3f4f6";
  const n = Number.parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)];
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function styles(style: DocumentStyle) {
  const size = style.baseFontSize;
  return StyleSheet.create({
    page: {
      paddingTop: MARGIN[style.margin],
      paddingBottom: MARGIN[style.margin] + footerReserve(style),
      paddingHorizontal: MARGIN[style.margin],
      fontSize: size,
      fontFamily: FONT_FAMILY[style.font],
      color: "#1f2937",
    },
    header: {
      borderBottomWidth: 2,
      borderColor: style.accentColor,
      paddingBottom: 10,
    },
    // The letterhead (logo, company) is its own band, so the title and the meta below it get the
    // full width: a document number never shares a row with a multiline address.
    letterhead: {
      flexDirection: "row",
      alignItems: "flex-start",
      marginBottom: 10,
    },
    logo: { width: 96, maxHeight: 48, objectFit: "contain", marginRight: 14 },
    title: {
      fontSize: size + 10,
      fontWeight: 700,
      color: style.accentColor,
    },
    subtitle: { fontSize: size + 1, color: "#4b5563", marginTop: 3 },
    companyBlock: { flex: 1, alignItems: "flex-end" },
    companyName: {
      fontSize: size + 1,
      fontWeight: 700,
      textAlign: "right",
    },
    company: { fontSize: size - 1, color: "#6b7280", textAlign: "right" },
    // Label over value, two to a row: a long label wraps in its own line and never leaves the
    // value without width. A value too long for half a row (an email, a URL) has no space to break
    // at, so its cell grows to the whole row instead of painting over the next one.
    metaGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
    metaCell: { flexGrow: 1, minWidth: "50%", paddingRight: 12, marginTop: 4 },
    metaLabel: {
      fontSize: size - 2,
      color: "#6b7280",
      letterSpacing: LABEL_SPACING,
    },
    metaValue: { fontSize: size - 1, fontWeight: 700 },
    heading: {
      fontSize: size + 3,
      fontWeight: 700,
      color: style.accentColor,
    },
    muted: { color: "#6b7280" },
    bulletRow: { flexDirection: "row" },
    bulletMark: { width: 10, color: style.accentColor },
    pairRow: { marginBottom: 6, paddingRight: 12 },
    pairLabel: {
      fontSize: size - 2,
      color: "#6b7280",
      letterSpacing: LABEL_SPACING,
    },
    tableHead: {
      flexDirection: "row",
      backgroundColor: tint(style.accentColor, 0.9),
      paddingVertical: 5,
      paddingHorizontal: 6,
    },
    tableHeadCell: {
      fontSize: size - 1,
      fontWeight: 700,
      color: style.accentColor,
    },
    tableRow: {
      flexDirection: "row",
      borderBottomWidth: 0.5,
      borderColor: "#e5e7eb",
      paddingVertical: 5,
      paddingHorizontal: 6,
    },
    totals: { alignSelf: "flex-end", width: 230, paddingHorizontal: 6 },
    totalsRow: { flexDirection: "row", paddingVertical: 1.5 },
    totalsGrandRow: {
      flexDirection: "row",
      borderTopWidth: 1.5,
      borderColor: style.accentColor,
      marginTop: 4,
      paddingTop: 5,
    },
    totalsLabel: { flex: 1, textAlign: "right", color: "#6b7280" },
    totalsValue: { width: 100, textAlign: "right" },
    grandTotal: {
      fontSize: size + 3,
      fontWeight: 700,
      color: style.accentColor,
    },
    divider: { borderBottomWidth: 0.75, borderColor: "#d1d5db" },
    footer: {
      position: "absolute",
      bottom: MARGIN[style.margin] - 12,
      left: MARGIN[style.margin],
      right: MARGIN[style.margin],
      flexDirection: "row",
      justifyContent: "space-between",
      fontSize: size - 2,
      color: "#9ca3af",
    },
    // Clipped to what footerReserve reserves for. `maxLines` is a STYLE property in @react-pdf (the
    // layout reads `node.style.maxLines`) — passed as a prop it is accepted, ignored, and the footer
    // grows past the space the page held for it.
    // A `render` text is drawn after layout, so the row cannot measure it: it gets a fixed width,
    // enough for "Página 999/999", and the footer text wraps in what is left.
    pageNumber: {
      width: Math.ceil(
        (LABELS[style.locale].page.length + 8) * (size - 2) * 0.6,
      ),
      textAlign: "right",
    },
    footerText: {
      flex: 1,
      marginRight: 8,
      maxLines: FOOTER_MAX_LINES,
      textOverflow: "ellipsis",
    },
  });
}

type Sheet = ReturnType<typeof styles>;

function spanStyle(span: InlineSpan) {
  return {
    ...(span.bold ? { fontWeight: 700 as const } : {}),
    ...(span.italic ? { fontStyle: "italic" as const } : {}),
  };
}

function InlineText({ spans }: { spans: InlineSpan[] }) {
  // NOTE: a line with no spans renders a single space, not nothing. @react-pdf gives an empty <Text>
  // zero height, so a blank line written to separate two paragraphs disappears and the document
  // arrives as one wall of text — which is precisely what the author used the blank line to avoid.
  if (spans.length === 0) return <Text> </Text>;
  return (
    <>
      {spans.map((span, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: render-only list, stable within one render.
        <Text key={i} style={spanStyle(span)}>
          {span.text}
        </Text>
      ))}
    </>
  );
}

function itemsOf(values: DocumentValues, field: string): LineItemValue[] {
  const value = values[field];
  return Array.isArray(value) ? value : [];
}

function amountOf(
  values: DocumentValues,
  field: string | undefined,
): number | undefined {
  if (!field) return undefined;
  const value = values[field];
  return typeof value === "number" ? value : undefined;
}

function renderBlock(
  block: DocumentBlock,
  input: DocumentRenderInput,
  sheet: Sheet,
  vars: Record<string, string>,
) {
  const { style, values, company, logo } = input;
  const L = LABELS[style.locale];
  const text = (raw: string) => resolveTokens(raw, vars);

  switch (block.type) {
    case "header": {
      const companyLine = [company.name, company.document, company.address]
        .filter(Boolean)
        .join(" · ");
      const contactLine = [company.phone, company.email, company.website]
        .filter(Boolean)
        .join(" · ");
      const showCompany =
        block.showCompany !== false && (!!companyLine || !!contactLine);
      const line = PAGE_WIDTH[style.pageSize] - 2 * MARGIN[style.margin];
      const size = style.baseFontSize;
      const bold = BOLD_FONT[style.font];
      const showLogo = block.showLogo !== false && !!logo;
      // The logo's box (width plus its right margin) is what the company block does not get.
      const companyWidth = line - (showLogo ? 96 + 14 : 0);
      return (
        <View style={sheet.header}>
          {(showLogo && logo) || showCompany ? (
            <View style={sheet.letterhead}>
              {showLogo && logo ? (
                <Image style={sheet.logo} src={logo} />
              ) : null}
              {showCompany ? (
                <View style={sheet.companyBlock}>
                  {company.name ? (
                    <Text
                      style={sheet.companyName}
                      hyphenationCallback={headerBreaks(
                        bold,
                        size + 1,
                        companyWidth,
                      )}
                    >
                      {company.name}
                    </Text>
                  ) : null}
                  {[
                    company.document,
                    company.address,
                    company.phone,
                    company.email,
                    company.website,
                  ]
                    .filter(Boolean)
                    .map((entry) => (
                      <Text
                        key={entry}
                        style={sheet.company}
                        hyphenationCallback={headerBreaks(
                          FONT_FAMILY[style.font],
                          size - 1,
                          companyWidth,
                        )}
                      >
                        {entry}
                      </Text>
                    ))}
                </View>
              ) : null}
            </View>
          ) : null}
          {block.title ? (
            <Text
              style={sheet.title}
              hyphenationCallback={headerBreaks(bold, size + 10, line)}
            >
              {text(block.title)}
            </Text>
          ) : null}
          {block.subtitle ? (
            <Text
              style={sheet.subtitle}
              hyphenationCallback={headerBreaks(
                FONT_FAMILY[style.font],
                size + 1,
                line,
              )}
            >
              {text(block.subtitle)}
            </Text>
          ) : null}
          {block.meta?.length ? (
            <View style={sheet.metaGrid}>
              {block.meta.map((row) => (
                <View key={row.label} style={sheet.metaCell}>
                  <Text
                    style={sheet.metaLabel}
                    hyphenationCallback={headerBreaks(
                      FONT_FAMILY[style.font],
                      size - 2,
                      line - 12,
                      LABEL_SPACING,
                    )}
                  >
                    {printableUpperCase(text(row.label))}
                  </Text>
                  <Text
                    style={sheet.metaValue}
                    hyphenationCallback={headerBreaks(
                      bold,
                      size - 1,
                      line - 12,
                    )}
                  >
                    {text(row.value)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      );
    }

    case "text": {
      const lines = parseSimpleMarkdown(text(block.text));
      const variant =
        block.variant === "heading"
          ? sheet.heading
          : block.variant === "muted"
            ? sheet.muted
            : undefined;
      return (
        <View>
          {lines.map((line, i) =>
            line.kind === "bullet" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: render-only list, stable within one render.
              <View key={i} style={sheet.bulletRow}>
                <Text style={sheet.bulletMark}>•</Text>
                <Text
                  style={[
                    ...(variant ? [variant] : []),
                    { flex: 1, textAlign: block.align },
                  ]}
                >
                  <InlineText spans={line.spans} />
                </Text>
              </View>
            ) : (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: render-only list, stable within one render.
                key={i}
                style={[
                  ...(variant ? [variant] : []),
                  { textAlign: block.align },
                ]}
              >
                <InlineText spans={line.spans} />
              </Text>
            ),
          )}
        </View>
      );
    }

    case "fields": {
      const columns = block.columns ?? 1;
      const cellWidth =
        (PAGE_WIDTH[style.pageSize] - 2 * MARGIN[style.margin]) / columns - 12;
      return (
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {block.rows.map((row) => (
            <View
              key={row.label}
              style={[sheet.pairRow, { width: `${100 / columns}%` }]}
            >
              <Text
                style={sheet.pairLabel}
                hyphenationCallback={headerBreaks(
                  FONT_FAMILY[style.font],
                  style.baseFontSize - 2,
                  cellWidth,
                  LABEL_SPACING,
                )}
              >
                {printableUpperCase(text(row.label))}
              </Text>
              <Text>{text(row.value)}</Text>
            </View>
          ))}
        </View>
      );
    }

    case "lineItems": {
      const columns = block.columns ?? [...LINE_ITEM_COLUMNS];
      const items = itemsOf(values, block.field);
      const cell = (col: LineItemColumn) => ({
        flex: COLUMN_FLEX[col],
        textAlign: (col === "description" ? "left" : "right") as
          | "left"
          | "right",
      });
      return (
        <View>
          {block.showHeader === false ? null : (
            <View style={sheet.tableHead}>
              {columns.map((col) => (
                <Text key={col} style={[sheet.tableHeadCell, cell(col)]}>
                  {L[col]}
                </Text>
              ))}
            </View>
          )}
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: render-only list, stable within one render.
            <View key={i} style={sheet.tableRow}>
              {columns.map((col) => (
                <Text key={col} style={cell(col)}>
                  {col === "description"
                    ? item.description
                    : col === "quantity"
                      ? formatNumber(item.quantity, style.locale)
                      : col === "unitPrice"
                        ? formatMoney(
                            item.unitPrice,
                            style.locale,
                            style.currency,
                          )
                        : formatMoney(
                            lineTotal(item),
                            style.locale,
                            style.currency,
                          )}
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
    }

    case "totals": {
      const totals = computeTotals(itemsOf(values, block.field), {
        discount: amountOf(values, block.discountField),
        tax: amountOf(values, block.taxField),
      });
      // A discount or tax row nobody supplied is dropped rather than printed as zero: "Desconto:
      // R$ 0,00" reads like a refused discount, which is a claim the operator never made.
      const requested: TotalRow[] = block.rows ?? [
        "subtotal",
        "discount",
        "tax",
        "total",
      ];
      const rows = requested.filter(
        (row) =>
          row === "total" ||
          row === "subtotal" ||
          (row === "discount" && totals.discount > 0) ||
          (row === "tax" && totals.tax > 0),
      );
      const label: Record<TotalRow, string> = {
        subtotal: L.subtotal,
        discount: L.discount,
        tax: L.tax,
        total: L.grandTotal,
      };
      return (
        <View style={sheet.totals}>
          {rows.map((row) => (
            <View
              key={row}
              style={row === "total" ? sheet.totalsGrandRow : sheet.totalsRow}
            >
              <Text
                style={[
                  sheet.totalsLabel,
                  ...(row === "total" ? [sheet.grandTotal] : []),
                ]}
              >
                {`${label[row]} `}
              </Text>
              <Text
                style={[
                  sheet.totalsValue,
                  ...(row === "total" ? [sheet.grandTotal] : []),
                ]}
              >
                {formatMoney(
                  row === "discount" ? -totals.discount : totals[row],
                  style.locale,
                  style.currency,
                )}
              </Text>
            </View>
          ))}
        </View>
      );
    }

    case "divider":
      return <View style={sheet.divider} />;
  }
}

export async function renderDocumentPdf(
  input: DocumentRenderInput,
): Promise<Buffer> {
  const sheet = styles(input.style);
  const vars = buildDocumentVars({
    company: input.company,
    meta: input.meta,
    fields: input.fields,
    values: input.values,
    style: input.style,
  });
  const L = LABELS[input.style.locale];
  const doc = (
    <Document title={input.meta.title}>
      <Page size={input.style.pageSize} style={sheet.page}>
        {input.blocks.map((block) => (
          <View
            key={block.id}
            style={{ marginBottom: SPACE_AFTER[block.spaceAfter ?? "md"] }}
          >
            {renderBlock(block, input, sheet, vars)}
          </View>
        ))}
        {input.style.footerText || input.style.showPageNumbers ? (
          <View style={sheet.footer} fixed>
            <Text style={sheet.footerText}>
              {input.style.footerText
                ? resolveFooterText(input.style.footerText, vars)
                : ""}
            </Text>
            {input.style.showPageNumbers ? (
              <Text
                style={sheet.pageNumber}
                render={({ pageNumber, totalPages }) =>
                  `${L.page} ${pageNumber}/${totalPages}`
                }
              />
            ) : (
              <Text> </Text>
            )}
          </View>
        ) : null}
      </Page>
    </Document>
  );
  return renderToBuffer(doc);
}
