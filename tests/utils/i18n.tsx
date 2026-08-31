/// <reference lib="dom" />

import { createInstance, type i18n as I18n, type Resource } from "i18next";
import type { ReactElement, ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

// A REAL i18next, PER FILE, INSTEAD OF A STUB IN THE PROCESS REGISTRY.
//
// Nine test files used to open by stubbing this package in the module registry, handing back a
// hand-written `useTranslation`. That call has no file scope and no teardown, so the stub the LAST
// of them installed is what every file afterwards imported, and the `i18n` inside it was a literal
// `{ language: "en" }`. A file downstream reading the language for real therefore read a constant.
//
// Measured: tests/client/document-starters-race.test.tsx switches the language to prove a stale
// starter list cannot overwrite a newer one, and `DocumentsPanel` picks its locale with
// `i18n.language.startsWith("pt")`. Against the frozen stub the switch changed nothing, both loads
// asked for the same locale, and the race the test exists to lose stopped happening, silently,
// because the assertions still found the English list they were handed.
//
// What replaces it is not a better stub. `t(key, fallback)` is i18next's own `defaultValue`
// signature, so an instance with EMPTY resources answers exactly what those stubs answered:
//
//     t("theme.label", "Theme")            -> "Theme"        (the fallback)
//     t("theme.light")                     -> "theme.light"  (the key, no fallback given)
//     t("x", "hi {{ref}}", { ref: "Z" })   -> "hi Z"         (real interpolation)
//
// The third line is the #435 defect the stub ledger describes: four hand-written `t`s dropped the
// vars argument and a label reached the DOM holding a literal `{{ref}}`. It cannot recur here,
// because nobody is writing `t` any more.
//
// And the instance travels by CONTEXT, through `I18nextProvider`, which is what makes this per-file:
// `useTranslation` reads the context first and only falls back to the global instance when there is
// none. Nothing is written to the module registry, so there is nothing to leak and nothing to undo.
//
// `useSuspense: false` because these tests render without a Suspense boundary; the default would
// suspend on the first render and the tree would never appear.
//
// `resources` is for the one test file that asserts against the REAL catalogs: pass them and `t`
// answers the catalog entry where there is one and the fallback where there is not, which is what a
// hand-written lookup in that file used to do by hand.
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
