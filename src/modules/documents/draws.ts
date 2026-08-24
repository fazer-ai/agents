import type { CompanySettings } from "@/modules/tenant-settings/service";
import type { DocumentBlock, DocumentField, DocumentStyle } from "./blocks";
import { resolveTokens } from "./tokens";
import { computeTotals } from "./totals";
import type { DocumentValues, LineItemValue } from "./validate";
import { buildDocumentVars, type DocumentMeta } from "./vars";

// Does this document put ANYTHING on the page?
//
// The invariant is narrow and worth stating plainly: a customer never receives a blank PDF, and a
// blank PDF never consumes a number from a template's sequence. Once issued, a document is
// immutable — nothing repairs one afterwards.
//
// Asked HERE, with the values resolved, rather than at authoring time. Four review rounds tried to
// answer it from the template alone and each found another conditional the one before had missed:
// a text block that is only `{{notes}}` for an optional field, a header showing a logo the tenant
// has not uploaded, a totals block asking for a discount row the renderer drops when the discount
// is zero, a hidden table backed by a field the agent omitted. They are all the same shape — the
// template does not know, because the answer depends on values that arrive at the turn. A static
// check either guesses (and refuses templates that are perfectly fine for the tenant that wrote
// them) or misses. With the values in hand there is nothing to guess.
//
// What DOES stay at authoring is the half that is unconditional: a layout with no blocks, or one
// made of dividers and empty text, can never draw for any values. An error at the keyboard beats a
// surprise at the turn, and that check costs one pass over the blocks.
//
// MIRRORS THE RENDERER, and that is the risk: these conditions are the renderer's, restated. They
// are held to it by tests/modules/document-draws.test.ts, which renders each case and compares this
// answer against what the PDF actually drew — in both directions.
export interface DrawsInput {
  blocks: DocumentBlock[];
  fields: DocumentField[];
  style: DocumentStyle;
  values: DocumentValues;
  company: CompanySettings;
  meta: DocumentMeta;
  // Whether a logo file is actually available to draw. The settings naming one is not the same
  // thing: the file can be missing, and the renderer draws nothing when it is.
  hasLogo: boolean;
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

export function documentDraws(input: DrawsInput): boolean {
  const vars = buildDocumentVars({
    company: input.company,
    meta: input.meta,
    fields: input.fields,
    values: input.values,
    style: input.style,
  });
  const text = (raw: string) => resolveTokens(raw, vars).trim();
  return input.blocks.some((block) => {
    switch (block.type) {
      case "divider":
        // A rule across the page is not content: a document that is one line and nothing else is
        // the blank page this exists to refuse.
        return false;
      case "text":
        // After tokens: a block that is only `{{notes}}` draws nothing when notes was omitted.
        return text(block.text) !== "";
      case "header": {
        // TRIMMED before it counts. `filter(Boolean)` keeps " ", and a company field holding one
        // space is accepted by the API and by the console — so a document whose only visible block
        // is a header would pass this gate on a value that prints nothing, take a number, and reach
        // the customer as a blank page. The renderer joins these with a separator and draws no glyph
        // for whitespace, so "has content" has to mean the same thing here as it does there.
        const printable = (values: (string | null | undefined)[]) =>
          values
            .map((v) => v?.trim() ?? "")
            .filter(Boolean)
            .join("");
        const companyLine = printable([
          input.company.name,
          input.company.document,
          input.company.address,
        ]);
        const contactLine = printable([
          input.company.phone,
          input.company.email,
          input.company.website,
        ]);
        // `!== false` for both flags, because that is how the renderer reads them: a header that
        // says nothing about the logo still shows one.
        return Boolean(
          (block.showLogo !== false && input.hasLogo) ||
            text(block.title ?? "") ||
            text(block.subtitle ?? "") ||
            (block.showCompany !== false && (companyLine || contactLine)) ||
            block.meta?.length,
        );
      }
      case "fields":
        // Every row draws its label, whatever the value resolves to, and there is at least one.
        return block.rows.length > 0;
      case "lineItems":
        // The header row is content by itself; without it, only the items are.
        return (
          block.showHeader !== false ||
          itemsOf(input.values, block.field).length > 0
        );
      case "totals": {
        // The renderer drops a discount or tax row whose amount is absent or zero, so a block that
        // asks for only those draws nothing when neither was supplied. Subtotal and total always
        // print, even at zero.
        const totals = computeTotals(itemsOf(input.values, block.field), {
          discount: amountOf(input.values, block.discountField),
          tax: amountOf(input.values, block.taxField),
        });
        const requested = block.rows ?? [
          "subtotal",
          "discount",
          "tax",
          "total",
        ];
        return requested.some(
          (row) =>
            row === "total" ||
            row === "subtotal" ||
            (row === "discount" && totals.discount > 0) ||
            (row === "tax" && totals.tax > 0),
        );
      }
      default:
        return true;
    }
  });
}
