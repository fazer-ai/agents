// The number an import warning is counting, read from either name it can arrive under: `count`, or
// `n`, which the knowledge-base and tool-grant warnings of the previous release carry. Both are read
// for the rolling-deploy overlap (docs/deploy.md), where a missing `count` coerced to 0 would render
// "0 bundled documents" for one; the producer sends both for the same window. Only the VALUE lives
// here: the `count` property stays written at each call site, because `i18next-parser` reads the
// call site, and a returned options object would be a spread it cannot read.
export function importWarningCount(
  params: Record<string, string | number> | undefined,
): number {
  const raw = params?.count ?? params?.n;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
