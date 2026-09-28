import type { Locale } from "@/api/lib/i18n";
import en from "@/client/locales/en.json";
import ptBR from "@/client/locales/pt-BR.json";

// The server's side of the shared message renderer: the console's own catalogs, resolved without an
// i18next instance, so the API says the same sentences the operator sees on screen. Every
// `editor.configIssue*` key exists in both languages (tests/modules/config-issue-i18n.test.ts).
const CATALOG: Record<Locale, unknown> = { en, "pt-BR": ptBR };

// i18next interpolation, for the four keys that take values. Deliberately not the library: pulling
// i18next in to substitute `{{name}}` would give the server a second instance to keep configured,
// and the note at the top of api/lib/i18n.ts is about exactly that hazard.
function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

function lookup(catalog: unknown, key: string): string | undefined {
  let node: unknown = catalog;
  for (const segment of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" ? node : undefined;
}

// A `translate` for configIssueMessage, bound to one language. An unknown key falls back to the
// English default the caller passed — the same behaviour i18next gives the console, so a key that
// somehow went missing reads as a sentence rather than as `editor.configIssue.model`.
export function configIssueTranslator(
  locale: Locale,
): (
  key: string,
  defaultValue: string,
  params?: Record<string, string | number>,
) => string {
  const catalog = CATALOG[locale] ?? en;
  return (key, defaultValue, params) =>
    interpolate(lookup(catalog, key) ?? defaultValue, params);
}
