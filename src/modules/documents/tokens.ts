// {{token}} resolution for document content. A sibling of the system prompt's placeholder machinery
// (src/graph/prompt.ts), deliberately NOT the same code, for two reasons that both bite:
//
//   1. `PROMPT_PLACEHOLDER_SOURCE` is a shared contract — the prompt editor's highlighter, the cache
//      warning and the prompt audit all read it. Widening it so a document can say {{empresa_nome}}
//      changes what the agent's system-prompt editor highlights, which is the wrong blast radius.
//   2. An unresolved prompt placeholder is left LITERAL, which is right for a prompt (the model can
//      still read it) and wrong for a document (the customer receives `{{validade}}` in a PDF). Here
//      an unknown token is refused when the template is written, and renders as empty if one ever
//      reaches the renderer anyway.

import { clipText } from "@/lib/text";

export const DOCUMENT_TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

// A declared field may not take one of these prefixes. Without the rule, a field named
// `empresa_nome` silently shadows the company profile — the operator sees their own value in the
// preview and never learns which one the renderer would have chosen.
export const RESERVED_TOKEN_PREFIXES = [
  "company_",
  "empresa_",
  "doc_",
  "documento_",
] as const;

export function isReservedTokenName(name: string): boolean {
  return RESERVED_TOKEN_PREFIXES.some((p) => name.startsWith(p));
}

// Canonical name → the pt-BR alias that resolves to the same value. Both spellings exist for the
// same reason the prompt variables carry both (contact_name/nome_contato): the operator writes the
// document in their own language, and a token that is "almost right" produces a blank in a customer
// document rather than an error anyone sees.
export const COMPANY_TOKEN_ALIASES: Record<string, string> = {
  company_name: "empresa_nome",
  company_document: "empresa_documento",
  company_address: "empresa_endereco",
  company_phone: "empresa_telefone",
  company_email: "empresa_email",
  company_website: "empresa_site",
};

export const DOCUMENT_TOKEN_ALIASES: Record<string, string> = {
  doc_number: "documento_numero",
  doc_date: "documento_data",
  doc_title: "documento_titulo",
};

export const RESERVED_TOKEN_NAMES: string[] = [
  ...Object.entries(COMPANY_TOKEN_ALIASES).flat(),
  ...Object.entries(DOCUMENT_TOKEN_ALIASES).flat(),
];

// Expands a canonical map to also answer to the aliases, so the resolver stays a plain lookup.
export function withAliases(
  values: Record<string, string>,
  aliases: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...values };
  for (const [canonical, alias] of Object.entries(aliases)) {
    if (canonical in values) out[alias] = values[canonical] as string;
  }
  return out;
}

const VALUE_MAX = 2_000;

// The document sibling of sanitizePromptValue, and the difference is the whole point: that one
// collapses every run of whitespace into a single space, which is correct for a value spliced into
// one line of a prompt and wrong here — a "notes" or "payment terms" field is legitimately several
// lines, and collapsing them turns a formatted document into a paragraph.
//
// Control characters still go: C0, DEL and C1 alike. U+0085 (NEL) is in the C1 range, is a line
// break to plenty of renderers, and is NOT matched by JS `\s`, so a filter written around \s lets it
// through.
export function sanitizeDocumentValue(
  v: string | null | undefined,
  max: number = VALUE_MAX,
): string {
  if (!v) return "";
  let out = "";
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n") {
      out += ch;
      continue;
    }
    const control =
      code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    // And half of a character. `for...of` yields a real astral character as ONE two-unit string, so
    // a single-unit one in the surrogate range never had its other half. It arrives that way from
    // any JSON source that spells it out (`"\ud800"`) — which is what a model writing a tool call
    // and a mirrored Chatwoot attribute both are — and the snapshot this value ends up in is a
    // `jsonb` column, where Postgres refuses the write outright rather than degrading it.
    const half = ch.length === 1 && code >= 0xd800 && code <= 0xdfff;
    if (control || half) {
      out += " ";
      continue;
    }
    out += ch;
  }
  // Trailing spaces per line, then runs of blank lines down to one, so a value pasted from a
  // spreadsheet does not open a hole in the middle of the page.
  const collapsed = out
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/[ \t]{2,}/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clipText(collapsed, max);
}

// Every token name a piece of text asks for, in order, deduplicated.
// Anything the resolver would NOT recognise, stated as the complement of what it does: remove every
// VALID token and see whether a brace pair survives. {{Company_name}} (capital), {{company-name}}
// (hyphen), {{}}, {{cliente (unclosed) and {{foo {{cliente}} (nested) all do, and all of them slip
// past `tokensIn`, which only reports what matches. Authoring accepted them and then `resolveTokens`
// did not match them either, so the braces printed verbatim in a document the customer keeps.
//
// Written as a complement rather than as a second pattern on purpose: a pattern for "looks like a
// token but is not one" has to enumerate the ways of being wrong, and the first version of it
// enumerated three and missed two. There is only one way to be RIGHT, and it is already written
// down one line above.
export function malformedTokenIn(text: string): string | null {
  const leftover = text.replace(DOCUMENT_TOKEN_RE, "\u0000");
  const at = Math.max(leftover.indexOf("{{"), leftover.indexOf("}}"));
  const first = [leftover.indexOf("{{"), leftover.indexOf("}}")]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (first === undefined || at < 0) return null;
  // A short slice around the offending braces: the author needs to see WHICH one, and the whole
  // block's text would bury it. Through `clipText` because the 40 is a CAP on the author's own
  // text, not a position the code computed: an emoji sitting on that boundary would otherwise put
  // half a character into the refusal, which is then quoted back through the API and to the model.
  return clipText(leftover.slice(first), 40).split("\u0000")[0] ?? "{{";
}

export function tokensIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(DOCUMENT_TOKEN_RE)) {
    const name = m[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

// Replaces every {{token}} with its value. An unknown token becomes the empty string rather than
// staying literal: by the time text reaches here the template has already been validated, so an
// unknown token is a bug on our side, and printing `{{foo}}` in a document the customer keeps is a
// worse way to report it than printing nothing.
export function resolveTokens(
  text: string,
  vars: Record<string, string>,
): string {
  return text.replace(DOCUMENT_TOKEN_RE, (_match, name: string) =>
    sanitizeDocumentValue(vars[name] ?? ""),
  );
}
