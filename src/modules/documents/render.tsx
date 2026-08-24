import {
  Document,
  Image,
  Page,
  renderToBuffer,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
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
import { resolveTokens } from "./tokens";
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

// The footer is drawn as an absolutely-positioned `fixed` element, so it is outside the flow and the
// page has to be told where the body must stop. Two things went wrong with one number: the space was
// reserved when `showPageNumbers` was on, while the footer RENDERS whenever there is footer text or
// page numbers — so a footer with text and no numbers floated over the last rows of the body, on
// every page. Asked as one question here, by the same condition that decides whether it renders.
//
// And a reserve is only a bound if what it reserves for cannot grow past it. The authored footer is
// capped at 200 characters, but a `{{token}}` in it resolves at issuance to whatever the field
// holds, so the DRAWN footer is unbounded — which is why it is clipped to the same number of lines
// this reserves for.
export const FOOTER_MAX_LINES = 2;

export function footerReserve(style: DocumentStyle): number {
  if (!style.footerText && !style.showPageNumbers) return 0;
  return FOOTER_MAX_LINES * Math.round((style.baseFontSize - 2) * 1.4);
}

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

function styles(style: DocumentStyle) {
  const size = style.baseFontSize;
  return StyleSheet.create({
    page: {
      paddingTop: MARGIN[style.margin],
      paddingBottom: MARGIN[style.margin] + footerReserve(style),
      paddingHorizontal: MARGIN[style.margin],
      fontSize: size,
      fontFamily: FONT_FAMILY[style.font],
      color: "#111827",
    },
    headerRow: { flexDirection: "row", alignItems: "flex-start" },
    logo: { width: 96, maxHeight: 48, objectFit: "contain", marginRight: 14 },
    headerText: { flex: 1 },
    title: { fontSize: size + 8, color: style.accentColor },
    subtitle: { fontSize: size + 1, color: "#4b5563", marginTop: 2 },
    company: { fontSize: size - 1, color: "#6b7280", marginTop: 6 },
    metaRow: { flexDirection: "row", marginTop: 2 },
    metaLabel: { fontSize: size - 1, color: "#6b7280" },
    metaValue: { fontSize: size - 1 },
    heading: { fontSize: size + 3, color: style.accentColor },
    muted: { color: "#6b7280" },
    bulletRow: { flexDirection: "row" },
    bulletMark: { width: 10 },
    pairRow: { flexDirection: "row", marginBottom: 2 },
    pairLabel: { color: "#6b7280" },
    tableHead: {
      flexDirection: "row",
      borderBottomWidth: 1.5,
      borderColor: style.accentColor,
      paddingBottom: 3,
    },
    tableRow: {
      flexDirection: "row",
      borderBottomWidth: 0.5,
      borderColor: "#e5e7eb",
      paddingVertical: 3,
    },
    totalsRow: { flexDirection: "row", justifyContent: "flex-end" },
    totalsLabel: { width: 110, textAlign: "right", color: "#6b7280" },
    totalsValue: { width: 90, textAlign: "right" },
    grandTotal: { fontSize: size + 2, color: style.accentColor },
    divider: { borderBottomWidth: 1, borderColor: "#e5e7eb" },
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
    footerText: {
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
      return (
        <View style={sheet.headerRow}>
          {block.showLogo !== false && logo ? (
            <Image style={sheet.logo} src={logo} />
          ) : null}
          <View style={sheet.headerText}>
            {block.title ? (
              <Text style={sheet.title}>{text(block.title)}</Text>
            ) : null}
            {block.subtitle ? (
              <Text style={sheet.subtitle}>{text(block.subtitle)}</Text>
            ) : null}
            {block.showCompany !== false && companyLine ? (
              <Text style={sheet.company}>{companyLine}</Text>
            ) : null}
            {block.showCompany !== false && contactLine ? (
              <Text style={sheet.company}>{contactLine}</Text>
            ) : null}
            {(block.meta ?? []).map((row) => (
              <View key={row.label} style={sheet.metaRow}>
                <Text style={sheet.metaLabel}>{`${text(row.label)}: `}</Text>
                <Text style={sheet.metaValue}>{text(row.value)}</Text>
              </View>
            ))}
          </View>
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
      return (
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {block.rows.map((row) => (
            <View
              key={row.label}
              style={[sheet.pairRow, { width: `${100 / columns}%` }]}
            >
              <Text style={sheet.pairLabel}>{`${text(row.label)}: `}</Text>
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
                <Text key={col} style={cell(col)}>
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
        <View>
          {rows.map((row) => (
            <View key={row} style={sheet.totalsRow}>
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
                ? resolveTokens(input.style.footerText, vars)
                : ""}
            </Text>
            {input.style.showPageNumbers ? (
              <Text
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
