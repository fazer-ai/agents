// NOTE: when I18N_STAGING_DIR is set (by scripts/i18n-extract.ts), the parser writes to a staging
// dir instead of the real locales. The script then copies a catalog back ONLY if its content
// changed, so a no-op extract never touches the real files (and never hot-reloads the dev server).
const staging = process.env.I18N_STAGING_DIR;

module.exports = {
  locales: ["en", "pt-BR"],
  output: staging
    ? `${staging}/client/$LOCALE.json`
    : "src/client/locales/$LOCALE.json",
  // The console's catalog, plus the ONE server-side file that renders from it. `configIssueMessage`
  // moved out of the editor component so the API could answer with the same sentences (#467), and
  // the parser deletes as orphaned every key it cannot see a call for: moving those five interpolated
  // keys' only call site out of `src/client` silently dropped them from both catalogs, leaving the
  // console to fall back to the English default for the pt-BR reader. If that file is ever renamed
  // or moved, the extract deletes them again — loudly, since CI runs `i18n:extract` and then fails on
  // a dirty tree.
  input: [
    "src/client/**/*.{ts,tsx}",
    "src/modules/agents/config-health-message.ts",
  ],
  defaultNamespace: "translation",
  keySeparator: ".",
  namespaceSeparator: ":",
  contextSeparator: "_",
  createOldCatalogs: false,
  defaultValue: (_locale, _namespace, _key, value) => value || "",
  keepRemoved: false,
  lexers: {
    ts: ["JavascriptLexer"],
    tsx: ["JsxLexer"],
  },
  lineEnding: "lf",
  sort: true,
  verbose: true,
};
