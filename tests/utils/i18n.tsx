/// <reference lib="dom" />

import { createInstance, type i18n as I18n, type Resource } from "i18next";
import type { ReactElement, ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

// A REAL i18next, PER FILE, INSTEAD OF A STUB IN THE PROCESS REGISTRY. A registry stub has no file
// scope and no teardown, so the last one installed is what every later file imports, with a
// constant `i18n.language`: tests/client/document-starters-race.test.tsx, which switches language to
// prove a stale starter list cannot overwrite a newer one, would pass without ever racing.
// `t(key, fallback)` is i18next's own `defaultValue` signature, so an instance with EMPTY resources
// answers what a stub would:
//
//     t("theme.label", "Theme")            -> "Theme"        (the fallback)
//     t("theme.light")                     -> "theme.light"  (the key, no fallback given)
//     t("x", "hi {{ref}}", { ref: "Z" })   -> "hi Z"         (real interpolation)
//
// Real interpolation keeps a label from reaching the DOM holding a literal `{{ref}}`, which a
// hand-written `t` that drops the vars argument does. The instance travels by CONTEXT, through
// `I18nextProvider`: `useTranslation` reads the context first, so nothing is written to the module
// registry and nothing leaks. `useSuspense: false` because these tests render without a Suspense
// boundary. `resources` is for the one file that asserts against the REAL catalogs: `t` answers the
// catalog entry where there is one and the fallback where there is not.
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
