import { describe, expect, test } from "bun:test";
import { buildCspDirectives, extractInlineScriptHashes } from "@/api/lib/csp";

const sha256b64 = (content: string) =>
  new Bun.CryptoHasher("sha256").update(content).digest("base64");

describe("extractInlineScriptHashes", () => {
  test("hashes a single inline script", () => {
    const content = "console.log(1);";
    const hashes = extractInlineScriptHashes(`<script>${content}</script>`);
    expect(hashes).toEqual([`'sha256-${sha256b64(content)}'`]);
  });

  test("skips external scripts with src attribute", () => {
    const html = `<script src="x.js"></script><script>inline</script>`;
    const hashes = extractInlineScriptHashes(html);
    expect(hashes).toEqual([`'sha256-${sha256b64("inline")}'`]);
  });

  test("skips empty or whitespace-only scripts", () => {
    const html = `<script></script><script>   </script><script>real</script>`;
    const hashes = extractInlineScriptHashes(html);
    expect(hashes).toEqual([`'sha256-${sha256b64("real")}'`]);
  });

  test("emits distinct hashes for multiple distinct scripts", () => {
    const html = `<script>a()</script><script>b()</script>`;
    const hashes = extractInlineScriptHashes(html);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  test("handles scripts with attributes other than src", () => {
    const content = "noop";
    const html = `<script type="module" nonce="x">${content}</script>`;
    const hashes = extractInlineScriptHashes(html);
    expect(hashes).toEqual([`'sha256-${sha256b64(content)}'`]);
  });

  test("hash matches exact content (no trimming, case-sensitive)", () => {
    const content = "\n  let X = 1;\n";
    const hashes = extractInlineScriptHashes(`<script>${content}</script>`);
    expect(hashes[0]).toBe(`'sha256-${sha256b64(content)}'`);
  });
});

const baseOpts = {
  inlineScriptHashes: [] as string[],
  cdnOrigin: null as string | null,
  googleOAuthEnabled: false,
  isDev: false,
};

describe("buildCspDirectives", () => {
  test("baseline without hashes or CDN uses only self/data:/blob:", () => {
    const d = buildCspDirectives(baseOpts);
    expect(d.scriptSrc).toEqual(["'self'"]);
    expect(d.styleSrc).toEqual(["'self'", "'unsafe-inline'"]);
    // blob: lets media (proxied voice notes/images + playground replay) render via object URLs.
    expect(d.imgSrc).toEqual(["'self'", "data:", "blob:"]);
    // Inter + JetBrains Mono load as woff2 from Google's font CDN (public/index.css @font-face).
    expect(d.fontSrc).toEqual(["'self'", "data:", "https://fonts.gstatic.com"]);
    expect(d.mediaSrc).toEqual(["'self'", "blob:"]);
    expect(d.connectSrc).toEqual(["'self'"]);
    // blob: lets the console embed a PDF it rendered itself (the document-template preview) in an
    // <iframe>. Without it the frame is blocked and the only trace is a line in the browser console,
    // so the preview reads as "renders blank" rather than as a policy refusal.
    expect(d.frameSrc).toEqual(["'self'", "blob:"]);
  });

  test("inline script hashes appear only in scriptSrc", () => {
    const d = buildCspDirectives({
      ...baseOpts,
      inlineScriptHashes: ["'sha256-abc'", "'sha256-def'"],
    });
    expect(d.scriptSrc).toEqual(["'self'", "'sha256-abc'", "'sha256-def'"]);
    expect(d.styleSrc).not.toContain("'sha256-abc'");
    expect(d.imgSrc).not.toContain("'sha256-abc'");
  });

  test("CDN origin is added to every asset-loading directive", () => {
    const d = buildCspDirectives({
      ...baseOpts,
      cdnOrigin: "https://cdn.example.com",
    });
    // NOTE: Regression guard for the original omission in styleSrc/fontSrc —
    // build.ts applies publicPath to every bundled asset (JS/CSS/fonts), so
    // each directive that governs an asset load must allow the CDN origin.
    expect(d.scriptSrc).toContain("https://cdn.example.com");
    expect(d.styleSrc).toContain("https://cdn.example.com");
    expect(d.imgSrc).toContain("https://cdn.example.com");
    expect(d.fontSrc).toContain("https://cdn.example.com");
    expect(d.mediaSrc).toContain("https://cdn.example.com");
    expect(d.connectSrc).toContain("https://cdn.example.com");
  });

  test("hashes and CDN compose without interfering", () => {
    const d = buildCspDirectives({
      ...baseOpts,
      inlineScriptHashes: ["'sha256-x'"],
      cdnOrigin: "https://cdn.example.com",
    });
    expect(d.scriptSrc).toEqual([
      "'self'",
      "'sha256-x'",
      "https://cdn.example.com",
    ]);
  });

  test("dev mode adds 'unsafe-inline' and 'unsafe-eval' to script-src", () => {
    // NOTE: The Bun dev server injects runtime scripts (visibility/unref
    // pings) into the served HTML whose hash is not knowable from disk.
    // Without these unsafe directives in dev, every page load would
    // generate a false-positive CSP violation.
    const d = buildCspDirectives({ ...baseOpts, isDev: true });
    expect(d.scriptSrc).toContain("'unsafe-inline'");
    expect(d.scriptSrc).toContain("'unsafe-eval'");
  });

  test("prod mode does NOT include 'unsafe-inline'/'unsafe-eval' in script-src", () => {
    const d = buildCspDirectives({ ...baseOpts, isDev: false });
    expect(d.scriptSrc).not.toContain("'unsafe-inline'");
    expect(d.scriptSrc).not.toContain("'unsafe-eval'");
  });

  test("googleOAuthEnabled adds GSI origin to script/style/connect/frame", () => {
    const d = buildCspDirectives({ ...baseOpts, googleOAuthEnabled: true });
    expect(d.scriptSrc).toContain("https://accounts.google.com");
    expect(d.styleSrc).toContain("https://accounts.google.com");
    expect(d.connectSrc).toContain("https://accounts.google.com");
    expect(d.frameSrc).toEqual([
      "'self'",
      "blob:",
      "https://accounts.google.com",
    ]);
    // NOTE: GSI does not load images/fonts; keep those directives lean.
    expect(d.imgSrc).not.toContain("https://accounts.google.com");
    expect(d.fontSrc).not.toContain("https://accounts.google.com");
  });

  // The document preview needs `'self'`/`blob:` in frame-src whether or not GSI is on, and the GSI
  // origin is ADDED to that rather than replacing it. Asserting the disabled case separately is what
  // catches a future edit that makes the two branches disagree — which is how the preview would work
  // only on instances with Google login configured.
  test("googleOAuth disabled keeps frame-src at self/blob:", () => {
    const d = buildCspDirectives({ ...baseOpts, googleOAuthEnabled: false });
    expect(d.frameSrc).toEqual(["'self'", "blob:"]);
    expect(d.frameSrc).not.toContain("https://accounts.google.com");
  });
});
