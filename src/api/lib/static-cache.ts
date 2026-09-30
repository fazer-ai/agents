// Cache policy for what the SPA catch-all and staticPlugin serve. The rules and why each one is
// load-bearing: docs/routing.md, "Cache policy of the document and the assets".

// Bun's bundler names every build output `<name>-<hash>.<ext>`, so a hashed name never changes
// content and can be cached for good. Everything else under the static root can change between
// deploys without its name changing.
const HASHED_ASSET_PATTERN = /-[a-z0-9]{8,}\.[\w]+$/i;

// build.ts copies public/assets/ verbatim, so nothing under /assets/ is a build output, whatever
// its name looks like: `inter-variable.woff2` passes the hash shape. The CDN worker (workers/cdn)
// applies the same rule; tests/workers/cdn.test.ts holds the two together.
const VERBATIM_PREFIX = "/assets/";

// The file types the static root serves. A last segment ending in one of these asks for a file,
// never for an SPA route, so a missing one is a 404 rather than the shell. A list rather than "any
// dot", because a route like `/users/jane.doe` must still reach the SPA.
const STATIC_ASSET_PATTERN =
  /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|json|txt|xml|webmanifest)$/i;

export const DOCUMENT_CACHE_CONTROL = "no-cache";
export const MISSING_ASSET_CACHE_CONTROL = "no-store";

export function isStaticAssetPath(path: string): boolean {
  return STATIC_ASSET_PATTERN.test(path);
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

export function cacheControlFor(path: string): string | undefined {
  if (isApiPath(path)) return undefined;
  if (path === "/" || path.endsWith(".html")) return DOCUMENT_CACHE_CONTROL;
  if (!isStaticAssetPath(path)) return undefined;
  return HASHED_ASSET_PATTERN.test(path) && !path.startsWith(VERBATIM_PREFIX)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=86400";
}

// The app's onAfterHandle. The policy is written onto a returned Response, because staticPlugin
// answers with its own Response carrying `public, max-age=86400` and Elysia fills in only the
// `set.headers` keys that Response lacks. Only a 200 (and the 304 that revalidates it) describes
// the file at that path, so no other status is stamped: a 404 for a removed bundle must never be
// cached as immutable.
export function applyStaticCacheControl({
  path,
  set,
  responseValue,
}: {
  path: string;
  set: { status?: number | string; headers: Record<string, string | number> };
  responseValue: unknown;
}): void {
  const response = responseValue instanceof Response ? responseValue : null;
  const status = response?.status ?? set.status ?? 200;
  if (status !== 200 && status !== 304) return;

  const cacheControl = cacheControlFor(path);
  if (!cacheControl) return;

  if (response) {
    response.headers.set("cache-control", cacheControl);
  } else {
    set.headers["cache-control"] = cacheControl;
  }
}

// The production SPA catch-all. staticPlugin registers only the files that exist, so every other
// GET lands here: a deep route gets the shell, revalidated on every load so a deploy is picked up,
// and a missing file gets a 404 nothing may store, instead of HTML under a `.js` URL.
export function productionIndexHandler(documentPath: string) {
  return ({
    path,
    set,
  }: {
    path: string;
    set: { status?: number | string; headers: Record<string, string | number> };
  }) => {
    if (isStaticAssetPath(path)) {
      set.status = 404;
      set.headers["cache-control"] = MISSING_ASSET_CACHE_CONTROL;
      return "Not Found";
    }
    set.headers["cache-control"] = DOCUMENT_CACHE_CONTROL;
    return Bun.file(documentPath);
  };
}
