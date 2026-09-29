/// <reference lib="dom" />

import { createInstance, type i18n as I18n, type Resource } from "i18next";
import type { ReactElement, ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

// A real i18next per file, passed by CONTEXT through `I18nextProvider`, instead of a stub in the
// process registry: a registry stub has no teardown, so the last one installed leaks into every later
// file with a constant `i18n.language` (tests/client/document-starters-race.test.tsx would pass
// without racing). With EMPTY resources, `t(key, fallback)` answers the fallback, the key when none is
// given, and real interpolation, so a label never reaches the DOM holding a literal `{{ref}}`.
// `useSuspense: false` because these tests render without a Suspense boundary. `resources` is for the
// file that asserts against the REAL catalogs: the catalog entry where there is one, else the fallback.
export function createTestI18n(lng = "en", resources?: Resource): I18n {
  const instance = createInstance();
  instance.init({
    lng,
    resources: resources ?? {
      en: { translation: {} },
      "pt-BR": { translation: {} },
    },
    fallbackLng: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}

// Wraps a tree in a fresh instance. Use the two-argument form when the test needs to hold the
// instance to read `language` off it or to switch it mid-test.
export function withI18n(children: ReactNode, instance?: I18n): ReactElement {
  return (
    <I18nextProvider i18n={instance ?? createTestI18n()}>
      {children}
    </I18nextProvider>
  );
}
