// Validates a `?redirect=` value against open redirect. "Internal" is decided by what the BROWSER
// does with the value, never by a string prefix: the URL parser strips ASCII tab/newline from the
// whole input and treats `\` as `/` for http(s), so `/\evil.example` and `/\t/evil.example` read as
// single-leading-slash paths yet resolve to another origin. Resolving with `new URL` and comparing
// the resulting origin catches every such form instead of enumerating them.
export function resolveSafeRedirect(
  value: string | null | undefined,
  origin: string,
): string | null {
  if (!value?.startsWith("/")) return null;
  let resolved: URL;
  try {
    resolved = new URL(value, origin);
  } catch {
    return null;
  }
  if (resolved.origin !== origin) return null;
  // NOTE: a same-origin value can still normalize to a pathname starting with `//`
  // ("/a/..//evil.example"), which react-router and the browser read as protocol-relative.
  if (resolved.pathname.startsWith("//")) return null;
  return resolved.pathname + resolved.search + resolved.hash;
}
