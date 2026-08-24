import { join } from "node:path";
import config from "@/config";
import { OAUTH_CALLBACK_SCRIPT } from "@/modules/vault/oauth-core";

// Every OAuth consent popup (google_oauth, mcp_oauth) renders the SAME FIXED inline script
// (OAUTH_CALLBACK_SCRIPT); the per-render data — including the channel/type — rides in a
// non-executable application/json block that needs no hash. Pin the one script's sha256 in
// script-src so production CSP allows it.
const OAUTH_CALLBACK_SCRIPT_HASH = `'sha256-${new Bun.CryptoHasher("sha256")
  .update(OAUTH_CALLBACK_SCRIPT)
  .digest("base64")}'`;

const DIST_HTML = join(process.cwd(), "dist", "index.html");
const PUBLIC_HTML = join(process.cwd(), "public", "index.html");
const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const GSI_ORIGIN = "https://accounts.google.com";
// Inter + JetBrains Mono load as woff2 from Google's font CDN via @font-face in public/index.css.
// Allow that origin in font-src so the browser can fetch them instead of falling back to system fonts.
const GOOGLE_FONTS_ORIGIN = "https://fonts.gstatic.com";

export function extractInlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
    const content = match[1] ?? "";
    if (!content.trim()) continue;
    const digest = new Bun.CryptoHasher("sha256")
      .update(content)
      .digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

async function loadInlineScriptHashes(): Promise<string[]> {
  const htmlPath = config.env === "production" ? DIST_HTML : PUBLIC_HTML;
  try {
    return extractInlineScriptHashes(await Bun.file(htmlPath).text());
  } catch (err) {
    if (config.env === "production") {
      throw new Error(
        `CSP: could not read ${htmlPath} to compute inline script hashes (${
          err instanceof Error ? err.message : String(err)
        }). Run \`bun run build\` before starting the server in production.`,
      );
    }
    return [];
  }
}

function getCdnOrigin(): string | null {
  if (!config.cdnUrl) return null;
  let cdnOrigin: string;
  try {
    cdnOrigin = new URL(config.cdnUrl).origin;
  } catch {
    if (config.env === "production") {
      throw new Error(
        `CSP: invalid CDN_URL "${config.cdnUrl}". Expected an absolute URL so CSP can allow the CDN origin.`,
      );
    }
    return null;
  }
  // NOTE: Normalize both sides via URL so a trailing slash or path in
  // PUBLIC_URL does not cause a false mismatch against the CDN origin.
  let publicOrigin: string;
  try {
    publicOrigin = new URL(config.publicUrl).origin;
  } catch {
    return cdnOrigin;
  }
  return cdnOrigin === publicOrigin ? null : cdnOrigin;
}

export interface CspBuildOptions {
  inlineScriptHashes: string[];
  cdnOrigin: string | null;
  googleOAuthEnabled: boolean;
  isDev: boolean;
}

export function buildCspDirectives(
  opts: CspBuildOptions,
): Record<string, string[]> {
  const cdn = opts.cdnOrigin ? [opts.cdnOrigin] : [];
  const gsi = opts.googleOAuthEnabled ? [GSI_ORIGIN] : [];
  // NOTE: In dev, allow 'unsafe-inline'/'unsafe-eval' in script-src so the
  // Bun dev server's injected runtime scripts (visibility/unref pings, HMR)
  // do not fire false-positive CSP violations on every page load. Hashes
  // still pin scripts strictly in production.
  const devScriptUnsafe = opts.isDev
    ? ["'unsafe-inline'", "'unsafe-eval'"]
    : [];
  return {
    scriptSrc: [
      "'self'",
      ...devScriptUnsafe,
      ...opts.inlineScriptHashes,
      ...cdn,
      ...gsi,
    ],
    styleSrc: ["'self'", "'unsafe-inline'", ...cdn, ...gsi],
    // `blob:` covers object URLs: media (voice notes/images proxied through our origin and the
    // playground replay) is fetched as bytes and rendered via URL.createObjectURL — a blob: src.
    imgSrc: ["'self'", "data:", "blob:", ...cdn],
    fontSrc: ["'self'", "data:", GOOGLE_FONTS_ORIGIN, ...cdn],
    mediaSrc: ["'self'", "blob:", ...cdn],
    // NOTE: Same-origin WebSocket upgrades (`ws:` in dev, `wss:` in prod)
    // are covered by `'self'` per CSP3 in all evergreen browsers.
    connectSrc: ["'self'", ...cdn, ...gsi],
    // NOTE: `blob:` is what lets the console show a rendered PDF (the document-template preview) in
    // an <iframe> built from bytes the page fetched itself. Without it the frame is blocked and the
    // only trace is a line in the browser console — the preview simply appears blank. It widens what
    // this page may EMBED, not what it may load or send: `object-src` stays at helmet's `'none'`, and
    // a blob URL is same-origin by construction, minted by our own JS from a response we fetched.
    frameSrc: opts.googleOAuthEnabled
      ? ["'self'", "blob:", GSI_ORIGIN]
      : ["'self'", "blob:"],
  };
}

// Pin the shared OAuth consent-popup callback script (always present, independent of GSI login).
const inlineScriptHashes = [
  ...(await loadInlineScriptHashes()),
  OAUTH_CALLBACK_SCRIPT_HASH,
];
const cdnOrigin = getCdnOrigin();

export const cspDirectives = buildCspDirectives({
  inlineScriptHashes,
  cdnOrigin,
  googleOAuthEnabled: config.googleOAuthEnabled,
  isDev: config.env !== "production",
});
