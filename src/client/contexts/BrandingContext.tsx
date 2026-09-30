import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useTheme } from "@/client/contexts/ThemeContext";
import { api } from "@/client/lib/api";
import { applyFavicon } from "@/client/lib/favicon";
import {
  BRANDABLE_KEY_TO_VAR,
  BRANDING_CACHE_KEY,
  type BrandableKey,
  brandingAssetUrl,
  pickVariant,
  resolveBrandName,
  resolveBrandTokens,
} from "@/lib/branding";
import { derivePalette } from "@/lib/palette";

// GLOBAL app identity/branding, applied app-wide, anonymous pages like login/setup included. Colors
// go through setProperty on <html> (CSP-safe, NOT an inline <style>) and the favicon link is swapped
// in place; both re-apply on theme change so SIMPLE-mode derivation, per-theme ADVANCED tokens and
// the logo/favicon variant stay correct. FOUC: the localStorage cache SEEDS the initial state
// synchronously and colors apply in a layout effect, so a returning visitor's first frame already
// carries the brand while the fetch revalidates; only a cold first visit shows the default.

type BrandingData = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.branding.get>>["data"]
>;

function readCache(): BrandingData | null {
  try {
    const raw = localStorage.getItem(BRANDING_CACHE_KEY);
    return raw ? (JSON.parse(raw) as BrandingData) : null;
  } catch {
    return null;
  }
}

function writeCache(config: BrandingData): void {
  try {
    localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(config));
  } catch {
    // NOTE: ignore quota / unavailable localStorage — the cache is a FOUC optimization only.
  }
}

interface BrandingContextValue {
  config: BrandingData | null;
  // Theme-aware custom logo URL, or null to fall back to the bundled default asset.
  logoUrl: string | null;
  // Theme-aware custom icon (the favicon), which stands in for the logo where only a square symbol
  // fits (the collapsed sidebar). Null when none is configured.
  markUrl: string | null;
  // Resolved white-label display name (the configured brandName, or the default).
  brandName: string;
  // false until the first config load resolves (cache hit OR fetch settled). While false the
  // <Logo> renders nothing — so a cold first load never flashes the default logo before we know
  // which one applies. A returning visitor (cache hit) is ready synchronously on the first render.
  ready: boolean;
  refresh: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

// CSS vars we last set on <html>, so a re-apply (theme/mode change) clears them first
// (setProperty is additive — without the reset, a no-longer-set var would linger).
let appliedVars: string[] = [];

// Any CSS color as #rrggbb, by painting one pixel: the canvas converts oklch/hsl/rgb() to sRGB.
// Null when there is no canvas (tests, very old browsers).
function cssColorToHex(color: string): string | null {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function applyColors(
  config: BrandingData | null,
  theme: "light" | "dark",
): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const v of appliedVars) style.removeProperty(v);
  appliedVars = [];
  if (!config) return;

  const vars: Record<string, string> = {};
  if (config.colorMode === "SIMPLE") {
    if (config.brandColor) {
      const palette = derivePalette(config.brandColor, theme);
      if (palette) {
        for (const key of Object.keys(palette) as BrandableKey[]) {
          vars[BRANDABLE_KEY_TO_VAR[key]] = palette[key];
        }
      }
    }
  } else {
    const tokens = resolveBrandTokens(
      theme === "dark" ? config.tokensDark : config.tokensLight,
      cssColorToHex,
    );
    for (const [key, value] of Object.entries(tokens)) {
      const varName = BRANDABLE_KEY_TO_VAR[key as BrandableKey];
      if (varName && typeof value === "string") vars[varName] = value;
    }
  }
  for (const [name, value] of Object.entries(vars))
    style.setProperty(name, value);
  appliedVars = Object.keys(vars);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  // Seed synchronously from the cache so the first render already carries the custom brand.
  const [config, setConfig] = useState<BrandingData | null>(readCache);
  // Ready immediately on a cache hit; otherwise wait for the first fetch to settle (see above).
  const [ready, setReady] = useState<boolean>(config !== null);

  const refresh = useCallback(async () => {
    try {
      const { data, error } = await api.api.v1.branding.get();
      if (!error && data) {
        setConfig(data);
        writeCache(data);
      }
    } catch {
      // Non-fatal: fall back to the cached/default theme/logo/favicon.
    } finally {
      // We now know the answer (custom or default) either way — release the <Logo> gate.
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const brandName = resolveBrandName(config);

  // The document title follows the brand name (the default is the product's own brand).
  useLayoutEffect(() => {
    if (typeof document !== "undefined") document.title = brandName;
  }, [brandName]);

  // Layout effects (run before paint) so the seeded config is applied on the first frame — no
  // flash of the default accent for a returning visitor.
  useLayoutEffect(() => {
    applyColors(config, resolvedTheme);
  }, [config, resolvedTheme]);

  useLayoutEffect(() => {
    if (!config) return;
    const variant = pickVariant(config.favicon, resolvedTheme);
    applyFavicon(
      variant ? brandingAssetUrl("favicon", variant, config.version) : null,
    );
  }, [config, resolvedTheme]);

  const logoUrl = useMemo(() => {
    if (!config) return null;
    const variant = pickVariant(config.logo, resolvedTheme);
    return variant ? brandingAssetUrl("logo", variant, config.version) : null;
  }, [config, resolvedTheme]);

  const markUrl = useMemo(() => {
    if (!config) return null;
    const variant = pickVariant(config.favicon, resolvedTheme);
    return variant
      ? brandingAssetUrl("favicon", variant, config.version)
      : null;
  }, [config, resolvedTheme]);

  const value = useMemo<BrandingContextValue>(
    () => ({ config, logoUrl, markUrl, brandName, ready, refresh }),
    [config, logoUrl, markUrl, brandName, ready, refresh],
  );

  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  );
}

// Inert default for renders outside the provider (isolated component tests): the app always
// mounts BrandingProvider at the root, so in production this fallback is never hit. With it,
// <Logo> simply falls back to the bundled default asset instead of crashing.
const DEFAULT_VALUE: BrandingContextValue = {
  config: null,
  logoUrl: null,
  markUrl: null,
  brandName: resolveBrandName(null),
  // Outside the provider (isolated component tests) we render defaults immediately, never gated.
  ready: true,
  refresh: async () => {},
};

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext) ?? DEFAULT_VALUE;
}
