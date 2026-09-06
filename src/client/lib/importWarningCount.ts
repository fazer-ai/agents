// The number an import warning is counting, read from either name it can arrive under.
//
// `count` is the name since #513; `n` is what the two knowledge-base and tool-grant warnings carried
// before it. Both are read because of the rolling-deploy overlap (docs/deploy.md): an editor from
// this release can reach a container from the previous one, which sends `n` only, and a missing
// `count` coerced straight to 0 would render "0 bundled documents" for a warning about one. The
// producer sends both for the same window, in the other direction.
//
// Only the VALUE lives here. The `count` property itself stays written out at each call site,
// because `i18next-parser` reads the call site rather than the runtime: a helper that returned the
// whole options object would leave the parser seeing a spread it cannot read, which is how these
// keys were flat in the first place.
export function importWarningCount(
  params: Record<string, string | number> | undefined,
): number {
  const raw = params?.count ?? params?.n;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
