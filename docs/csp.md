# CSP and the cross-origin headers

How `src/app.ts` builds the Content-Security-Policy (enforced in production, Report-Only in dev), where the inline-script hashes come from, and what changes when Google Sign-In is enabled.

`src/app.ts` configures `elysia-helmet` with CSP always enabled. In production it enforces; in dev it runs in **Report-Only** mode (violations log to the browser console without blocking). Defaults from `elysia-helmet` cover `default-src`, `base-uri`, `form-action`, `frame-ancestors`, `object-src`, `script-src-attr`, and `upgrade-insecure-requests`. Directives set explicitly in `src/api/lib/csp.ts`: `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `frame-src`.

Inline scripts in `public/index.html` (e.g. the theme-detection script) are allowed via a `'sha256-...'` entry added to `script-src`. In production, hashes are computed from `dist/index.html`; in dev, from `public/index.html`. Dev also adds `'unsafe-inline'`/`'unsafe-eval'` to `script-src` because the Bun dev server injects runtime scripts whose hash is not knowable from disk.

Google Sign-In (GSI) directives (`accounts.google.com` in `script-src`, `style-src`, `connect-src`, `frame-src`) are added automatically when `GOOGLE_CLIENT_ID` is set. They are omitted when GSI is disabled.

Same gate applies to `Cross-Origin-Opener-Policy`: `elysia-helmet`'s default is `same-origin`, which nulls `window.opener` in cross-origin popups and breaks GSI's "Continue with Google" button (`Cannot read properties of null (reading 'postMessage')`). When `GOOGLE_CLIENT_ID` is set, `src/app.ts` relaxes COOP to `same-origin-allow-popups`. Projects without GSI keep the stricter default. The One Tap prompt is unaffected either way because it runs in an iframe.

**IMPORTANT:** Any edit to an inline script requires `bun run build` before starting the server in production, otherwise the hash in the CSP header will not match the served HTML and the browser will block the script. The server fails loudly at boot in production if `dist/index.html` is missing. In dev, CSP violations for inline scripts appear as console warnings (Report-Only) without breaking the page.

When adding external dependencies (analytics, captcha, CDN), extend the relevant directives in `buildCspDirectives` (e.g. add the origin to `scriptSrc` / `connectSrc` / `frameSrc`). The dev Report-Only mode will surface any missing allowlist entries in the browser console during local development.
