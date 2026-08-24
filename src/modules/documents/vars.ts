import type { CompanySettings } from "@/modules/tenant-settings/service";
import type { DocumentField, DocumentStyle } from "./blocks";
import { formatDate, formatMoney, formatNumber } from "./format";
import {
  COMPANY_TOKEN_ALIASES,
  DOCUMENT_TOKEN_ALIASES,
  sanitizeDocumentValue,
  withAliases,
} from "./tokens";
import type { DocumentValues } from "./validate";

export interface DocumentMeta {
  number: string;
  date: string;
  title: string;
}

export interface DocumentVarsInput {
  company: CompanySettings;
  meta: DocumentMeta;
  fields: DocumentField[];
  values: DocumentValues;
  style: DocumentStyle;
}

// Everything {{token}} can resolve to, in one map, ALREADY FORMATTED. Formatting here rather than at
// each use site is what makes a price written into a paragraph ("o total é {{valor}}") come out
// identical to the same price in the totals block — two spellings of one number in one document is
// the kind of inconsistency a customer reads as an error.
//
// A `lineItems` field resolves to the empty string: a table is not a token, and printing a JSON
// array into a sentence would be worse than printing nothing.
export function buildDocumentVars(
  input: DocumentVarsInput,
): Record<string, string> {
  const { company, meta, fields, values, style } = input;
  const companyVars = withAliases(
    {
      company_name: sanitizeDocumentValue(company.name),
      company_document: sanitizeDocumentValue(company.document),
      company_address: sanitizeDocumentValue(company.address),
      company_phone: sanitizeDocumentValue(company.phone),
      company_email: sanitizeDocumentValue(company.email),
      company_website: sanitizeDocumentValue(company.website),
    },
    COMPANY_TOKEN_ALIASES,
  );
  const docVars = withAliases(
    {
      doc_number: meta.number,
      doc_date: meta.date,
      doc_title: sanitizeDocumentValue(meta.title),
    },
    DOCUMENT_TOKEN_ALIASES,
  );

  const fieldVars: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined) {
      fieldVars[field.name] = "";
      continue;
    }
    switch (field.type) {
      case "currency":
        fieldVars[field.name] =
          typeof value === "number"
            ? formatMoney(value, style.locale, style.currency)
            : "";
        break;
      case "number":
        fieldVars[field.name] =
          typeof value === "number" ? formatNumber(value, style.locale) : "";
        break;
      case "date":
        fieldVars[field.name] =
          typeof value === "string" ? formatDate(value, style.locale) : "";
        break;
      case "text":
        fieldVars[field.name] =
          typeof value === "string" ? sanitizeDocumentValue(value) : "";
        break;
      case "lineItems":
        fieldVars[field.name] = "";
        break;
    }
  }

  return { ...companyVars, ...docVars, ...fieldVars };
}
