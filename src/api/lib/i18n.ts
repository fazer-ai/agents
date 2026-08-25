import { AsyncLocalStorage } from "node:async_hooks";
import { createInstance } from "i18next";
import en from "@/api/locales/en.json";
import ptBR from "@/api/locales/pt-BR.json";
import type { ErrorTranslationKey } from "@/lib/errors";

export type Locale = "en" | "pt-BR";

interface RequestContext {
  locale: Locale;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// NOTE: own instance, NOT the i18next singleton — the client bundle inits the singleton with the
// CLIENT locales, and any context where both coexist (bun test workers) would clobber the server
// resources (silently falling back to defaultValue).
// The two catalogs by locale, for reading a key's TEMPLATE before it is rendered.
const CATALOG: Record<Locale, { errors: Record<string, string> }> = {
  en,
  "pt-BR": ptBR,
};

const i18n = createInstance();

i18n.init({
  resources: {
    en: { translation: en },
    "pt-BR": { translation: ptBR },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

// The key is typed against the catalog, not `string`. i18next answers an unknown key with
// `defaultValue ?? key`, so a typo here is not an error and not a log line: it is the English
// fallback, or the key itself, rendered to a caller who asked for pt-BR.
export function translate(
  key: ErrorTranslationKey,
  defaultValue?: string,
): string {
  const ctx = requestContext.getStore();
  const locale = ctx?.locale ?? "en";
  return translateWithLocale(locale, key, defaultValue);
}

// NOTE: explicit-locale variant for contexts where the request ALS may not be in scope
// (e.g. Elysia's `onError`, which derives the locale straight from the Accept-Language header).
export function translateWithLocale(
  locale: Locale,
  key: ErrorTranslationKey,
  defaultValue?: string,
  params?: Record<string, string | number>,
): string {
  // A placeholder the caller never supplied survives i18next untouched, so the reader would get
  // `Unknown timezone: {{timezone}}.` — worse than the English it replaced, because the untranslated
  // fallback was already interpolated by the throw site. Three keys shipped in that state in the
  // round that registered them (issue #256 review), which is the same invisibility the whole catalog
  // guard exists for: nothing throws, nothing logs.
  //
  // Asked of the TEMPLATE, never of the rendered string. The rendered string carries interpolated
  // VALUES, and a value can legitimately hold braces: a document-template refusal quotes the token
  // it rejected (`token "{{cliente}}" names no field...`), so reading the output would call a
  // correct translation broken and drop it back to English. That regression is why this reads the
  // catalog instead.
  const template = CATALOG[locale].errors[key.slice("errors.".length)];
  const unfilled =
    template !== undefined &&
    [...template.matchAll(/\{\{(\w+)\}\}/g)].some(
      (m) => params?.[m[1] as string] === undefined,
    );
  // Information beats language: a pt-BR caller reading an English sentence that names the value can
  // act on it, and one reading `{{timezone}}` cannot.
  if (unfilled && defaultValue !== undefined) return defaultValue;

  // NOTE: params spread into the options bag — i18next resolves {{placeholders}} from it.
  return i18n.t(key, {
    lng: locale,
    defaultValue: defaultValue ?? key,
    ...params,
  });
}

export function getLocaleFromHeader(acceptLanguage: string | null): Locale {
  if (acceptLanguage?.includes("pt")) {
    return "pt-BR";
  }
  return "en";
}

export default i18n;
