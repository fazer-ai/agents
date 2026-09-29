// This module is the only place in the client allowed to read
// `process.env.BUN_PUBLIC_*`. The literal `process.env.BUN_PUBLIC_X` is
// inlined at build time via `define` in `build.ts`; in dev the browser has
// no `process` global, so a bare read throws `ReferenceError`. Centralizing
// the access keeps the try/catch in one spot and lets the rest of the
// codebase consume typed exports.
let cdnUrl = "";
try {
  cdnUrl = (process.env.BUN_PUBLIC_CDN_URL || "").replace(/\/$/, "");
} catch {}

export const CDN_URL = cdnUrl;

// App version (from package.json at build time, or a CI-provided BUN_PUBLIC_VERSION). Empty in dev
// (the dev server does not inline BUN_PUBLIC_*), so the sidebar footer simply omits it there.
let appVersion = "";
try {
  appVersion = process.env.BUN_PUBLIC_VERSION || "";
} catch {}

export const APP_VERSION = appVersion;

// Distribution edition: "free" (open-source, Pro features gated/stripped) or "full".
// Defaults to "full" in dev (BUN_PUBLIC_* is not inlined by the dev server), so Pro gates stay
// hidden while developing. The Free build sets BUN_PUBLIC_EDITION=free.
let edition = "full";
try {
  edition = process.env.BUN_PUBLIC_EDITION || "full";
} catch {}

export const EDITION = edition;
export const IS_FREE = edition === "free";
