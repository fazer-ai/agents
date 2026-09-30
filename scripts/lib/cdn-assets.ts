// The @font-face rules live in a <style> in public/index.html rather than in index.css, because
// Bun's CSS bundler rewrites every url() it can resolve into a base64 data: URI. The same placement
// keeps those URLs out of Bun's `publicPath`, so they stay root-relative and would be fetched from
// the application origin while every bundler-emitted asset moves to BUN_PUBLIC_CDN_URL. The files
// are already on the CDN (the release workflow uploads all of dist/); these helpers point the
// references there too.
const ROOT_RELATIVE_ASSET_URL = /url\((["']?)\/assets\//g;
const ANY_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

export function rewriteAssetUrlsForCdn(
  html: string,
  cdnUrl: string,
): { html: string; rewritten: number } {
  const trimmed = cdnUrl.replace(/\/$/, "");
  if (!trimmed) return { html, rewritten: 0 };

  let rewritten = 0;
  const out = html.replace(ROOT_RELATIVE_ASSET_URL, (_match, quote: string) => {
    rewritten += 1;
    return `url(${quote}${trimmed}/assets/`;
  });
  return { html: out, rewritten };
}

// What makes the rewrite trustworthy: it looks for what is LEFT rather than counting what the
// rewrite matched, which would agree with itself while a url() in another shape stayed on the
// application origin. Any url() that is neither absolute nor a data: URI was not reached.
export function findNonAbsoluteUrls(html: string): string[] {
  return [...html.matchAll(ANY_URL)]
    .map((match) => match[2] ?? "")
    .filter((url) => url !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(url));
}
