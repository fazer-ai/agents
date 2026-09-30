// Shared (server + client) branding allowlist + color-token validation. SINGLE source of truth so
// the server's write-time validation and the client's apply-time mapping never drift. The server
// sanitizes on write (never trust the client); the client maps these keys to CSS vars on apply.
// Pure module (no DOM, no node deps) so it is safe to import from both sides.

import { readableForeground } from "@/lib/palette";

export const BRANDABLE_KEYS = [
  "accent",
  "accentHover",
  "accentSoft",
  "accentSolid",
  "accentSolidHover",
  "accentForeground",
] as const;
export type BrandableKey = (typeof BRANDABLE_KEYS)[number];

// Brand-accent colors only — never structural bg/text (overriding those could destroy contrast).
// `accent` is the TEXT color (links, active labels) and `accentSolid` the FILL (primary buttons,
// switches, count pills), with `accentForeground` the text on that fill.
export const BRANDABLE_KEY_TO_VAR: Record<BrandableKey, string> = {
  accent: "--color-accent",
  accentHover: "--color-accent-hover",
  accentSoft: "--color-accent-soft",
  accentSolid: "--color-accent-solid",
  accentSolidHover: "--color-accent-solid-hover",
  accentForeground: "--color-accent-foreground",
};

// The ADVANCED tokens an install saved before the accent was split into text and fill set one
// `accent` for both. Without a fill of its own such a brand would keep the default fill under its
// own foreground color, so the fill falls back to the accent it was painted with then. The text on
// it came from the theme back then, and the new default (white) is not that, so a brand that set no
// foreground gets the one that reads on its fill. `toHex` lets a caller with a DOM resolve the forms
// this pure module cannot (oklch, rgb(), hsl).
export function resolveBrandTokens(
  tokens: Partial<Record<BrandableKey, string>>,
  toHex?: (color: string) => string | null,
): Partial<Record<BrandableKey, string>> {
  const out = { ...tokens };
  if (!out.accentSolid && out.accent) {
    out.accentSolid = out.accent;
    out.accentSolidHover ??= out.accentHover ?? out.accent;
    if (!out.accentForeground) {
      const foreground =
        readableForeground(out.accent) ??
        readableForeground(toHex?.(out.accent) ?? "");
      if (foreground) out.accentForeground = foreground;
    }
  }
  return out;
}

// A single color token: hex, or rgb(a)/hsl(a)/oklch/oklab/lab/lch functional forms. No url(), no
// semicolons/braces/comments, no expressions — the inner chars are a restricted safe set.
const COLOR_TOKEN =
  /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([0-9a-zA-Z.%,/\s-]+\))$/;

export function isValidColorToken(value: unknown): value is string {
  return typeof value === "string" && COLOR_TOKEN.test(value.trim());
}

const BRANDABLE_SET = new Set<string>(BRANDABLE_KEYS);

// The allowlisted, validated branding (short-key → trimmed color). Unknown keys and invalid
// values are dropped. The server stores exactly this; the client derives CSS vars from it.
export function sanitizeBranding(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (BRANDABLE_SET.has(k) && isValidColorToken(v)) {
      out[k] = (v as string).trim();
    }
  }
  return out;
}

// The white-label display name when none is configured (the product's own brand). It is also the
// `<title>` declared in `public/index.html`, so the cold-cache first paint already shows it.
export const DEFAULT_BRAND_NAME = "fazer.ai agents";

// Where the client caches the resolved global branding. Named here rather than in the provider
// because a second reader lives outside the bundle: the inline <head> script that stamps the tab
// title before React exists.
export const BRANDING_CACHE_KEY = "@app:branding";

// The white-label name to display: the configured one, or the product's own. Blank and whitespace
// count as unconfigured, and the configured name is displayed trimmed.
export function resolveBrandName(
  config: { brandName?: string | null } | null,
): string {
  return config?.brandName?.trim() || DEFAULT_BRAND_NAME;
}

// Where the branding binaries are served from. Public by design (they load before any auth
// context), and long-cached, so every URL carries the config's `version` as the cache buster.
export const BRANDING_ASSET_BASE = "/api/v1/branding/asset";

export function brandingAssetUrl(
  kind: "logo" | "favicon",
  variant: "dark" | "light",
  version: string,
): string {
  return `${BRANDING_ASSET_BASE}/${kind}/${variant}?v=${version}`;
}

// Prefer the variant matching the active theme; fall back to the other if only one was uploaded.
export function pickVariant(
  present: { dark: boolean; light: boolean },
  theme: "light" | "dark",
): "dark" | "light" | null {
  if (theme === "dark")
    return present.dark ? "dark" : present.light ? "light" : null;
  return present.light ? "light" : present.dark ? "dark" : null;
}

// Where the page's DECLARED icon links are kept, so a cleared favicon can restore them. The inline
// <head> script that applies the custom icon before the first paint has to remove them (leaving
// them in place makes the browser fetch the default too), so it writes them here on the way out
// and `applyFavicon` reads them back.
export const BRANDING_DEFAULT_FAVICONS_KEY = "__brandingDefaultFavicons";
