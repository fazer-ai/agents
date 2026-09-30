import type { BrandableKey } from "@/lib/branding";

// Pure color math (no DOM): derive the full accent palette (the BRANDABLE_KEYS) from a single
// brand color, per theme. This is what makes the SIMPLE branding mode theme-safe — the contrast
// foreground flips by luminance, and the text shade and soft tint move the right direction for
// each theme, instead of forcing one value across both (which breaks contrast in one of them).

type Rgb = { r: number; g: number; b: number };

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Mix a color toward white (target 255 = lighten) or black (target 0 = darken) by t in [0,1].
function mix(c: Rgb, target: 0 | 255, t: number): Rgb {
  return {
    r: c.r + (target - c.r) * t,
    g: c.g + (target - c.g) * t,
    b: c.b + (target - c.b) * t,
  };
}

// WCAG relative luminance (sRGB channels linearized).
function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// The two candidate text colors on an accent fill (matching the theme tokens), precomputed once.
const FG_DARK = "#1c1c1a";
const FG_LIGHT = "#ffffff";
const L_FG_DARK = relativeLuminance({ r: 28, g: 28, b: 26 });
const L_FG_LIGHT = relativeLuminance({ r: 255, g: 255, b: 255 });

// The lightest surface accent text sits on in each theme (--color-bg-tertiary): on the dark theme
// the text must clear it, and on the light theme it is the one closest to a light brand color.
const L_SURFACE_DARK = relativeLuminance({ r: 28, g: 28, b: 27 }); // #1c1c1b
const L_SURFACE_LIGHT = relativeLuminance({ r: 239, g: 239, b: 237 }); // #efefed

// The accent is a TEXT color (links, active labels), so it is held to WCAG AA for body text. The
// brand's own color is still what fills buttons (`accentSolid`), so nudging the text shade costs
// no fidelity where the brand is most visible.
const MIN_ACCENT_CONTRAST = 4.5;

// WCAG contrast ratio between two relative luminances.
function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

// Pick dark or white text for the HIGHER contrast against the accent fill (proper WCAG decision,
// not a single luminance threshold, which mis-picks mid-bright colors like #3ea6ff, where white
// text fails AA but dark text passes AAA).
function pickForeground(c: Rgb): string {
  const l = relativeLuminance(c);
  return contrastRatio(l, L_FG_DARK) >= contrastRatio(l, L_FG_LIGHT)
    ? FG_DARK
    : FG_LIGHT;
}

// Keep the accent legible as TEXT on the theme's surfaces: lighten on a dark theme / darken on a
// light one until it clears MIN_ACCENT_CONTRAST. Colors that already clear the bar are returned
// unchanged. The hue is preserved (mixing toward pure black/white scales channels linearly).
function ensureReadable(c: Rgb, bgL: number, target: 0 | 255): Rgb {
  if (contrastRatio(relativeLuminance(c), bgL) >= MIN_ACCENT_CONTRAST) return c;
  let out = c;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    out = mix(c, target, t);
    if (contrastRatio(relativeLuminance(out), bgL) >= MIN_ACCENT_CONTRAST)
      break;
  }
  return out;
}

// The text color that reads on `fill`, for a fill that is a hex color (#rgb, #rrggbb, #rrggbbaa; the
// alpha is ignored). Null for any other form, whose channels this module does not resolve.
export function readableForeground(fill: string): string | null {
  const m = /^#(?:([0-9a-fA-F]{3})|([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?)$/.exec(
    fill.trim(),
  );
  const hex = m?.[1] ? [...m[1]].map((c) => c + c).join("") : m?.[2];
  if (!hex) return null;
  const rgb = parseHex(hex);
  return rgb ? pickForeground(rgb) : null;
}

export type Theme = "light" | "dark";

// The BRANDABLE_KEYS → CSS color value map derived from `brandHex` for `theme`.
// Returns null if the brand color is not a parseable #rrggbb.
export function derivePalette(
  brandHex: string,
  theme: Theme,
): Record<BrandableKey, string> | null {
  const raw = parseHex(brandHex);
  if (!raw) return null;
  const dark = theme === "dark";
  // The fill is the brand color itself. Its hover moves AWAY from the foreground (darker under white
  // text, lighter under dark text), so the label never loses contrast on hover.
  const accentSolid = toHex(raw);
  const accentForeground = pickForeground(raw);
  const accentSolidHover = toHex(
    mix(raw, accentForeground === FG_LIGHT ? 0 : 255, 0.1),
  );
  const text = ensureReadable(
    raw,
    dark ? L_SURFACE_DARK : L_SURFACE_LIGHT,
    dark ? 255 : 0,
  );
  const accent = toHex(text);
  // Hover nudges the text further toward the readable direction.
  const accentHover = toHex(mix(text, dark ? 255 : 0, 0.14));
  // A translucent wash of the fill; alpha keeps it legible over every surface of the theme.
  const accentSoft = `rgba(${raw.r}, ${raw.g}, ${raw.b}, ${dark ? 0.2 : 0.12})`;
  return {
    accent,
    accentHover,
    accentSoft,
    accentSolid,
    accentSolidHover,
    accentForeground,
  };
}
