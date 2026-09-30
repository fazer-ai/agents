import { describe, expect, test } from "bun:test";
import { isValidColorToken, resolveBrandTokens } from "@/lib/branding";
import { derivePalette } from "@/lib/palette";

// Local WCAG helpers (mirror palette.ts) so assertions can check contrast directly.
function lum(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const toLin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLin((n >> 16) & 255);
  const g = toLin((n >> 8) & 255);
  const b = toLin(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("isValidColorToken", () => {
  test("accepts hex / rgb / hsl / oklch", () => {
    for (const v of [
      "#fff",
      "#ffaa00",
      "#ffaa00cc",
      "rgb(10, 20, 30)",
      "rgba(10,20,30,0.5)",
      "hsl(200 50% 40%)",
      "oklch(0.7 0.15 250)",
    ]) {
      expect(isValidColorToken(v)).toBe(true);
    }
  });

  test("rejects url(), injection, expressions and bare names", () => {
    for (const v of [
      "url(https://evil/x.png)",
      "#fff; background: url(x)",
      "red", // bare named colors are not allowed
      "expression(alert(1))",
      "oklch(0.7); }",
      "var(--x)",
      "",
    ]) {
      expect(isValidColorToken(v)).toBe(false);
    }
  });
});

describe("derivePalette (SIMPLE mode color math)", () => {
  // The lightest surface accent text is drawn on, per theme (--color-bg-tertiary).
  const SURFACE = { dark: "#1c1c1b", light: "#efefed" } as const;

  test("returns null for a non-#rrggbb brand color", () => {
    expect(derivePalette("not-a-color", "dark")).toBeNull();
    expect(derivePalette("#fff", "dark")).toBeNull(); // only 6-digit hex is derivable
    expect(derivePalette("rgb(1,2,3)", "light")).toBeNull();
  });

  test("the fill is the (normalized) brand color itself, in both themes", () => {
    expect(derivePalette("#ABCDEF", "dark")?.accentSolid).toBe("#abcdef");
    expect(derivePalette("#ABCDEF", "light")?.accentSolid).toBe("#abcdef");
  });

  test("the fill's hover moves away from its label, so the label never loses contrast", () => {
    // NOTE: the mid grey carries the dark label and the indigo the white one: both directions.
    for (const brand of ["#5e6ad2", "#888888", "#facc15", "#1e3a8a"]) {
      for (const theme of ["dark", "light"] as const) {
        const p = derivePalette(brand, theme);
        const fg = p?.accentForeground ?? "";
        expect(contrast(fg, p?.accentSolidHover ?? "")).toBeGreaterThanOrEqual(
          contrast(fg, p?.accentSolid ?? ""),
        );
      }
    }
  });

  test("the foreground is whichever of the two text colors reads better on the fill", () => {
    expect(derivePalette("#ffffff", "dark")?.accentForeground).toBe("#1c1c1a");
    expect(derivePalette("#000000", "light")?.accentForeground).toBe("#ffffff");
    expect(derivePalette("#2563eb", "light")?.accentForeground).toBe("#ffffff");
    // A mid-bright fill must pick the DARK text: white fails AA on it. A single luminance threshold
    // gets this wrong; the contrast ratio does not.
    expect(derivePalette("#3ea6ff", "dark")?.accentForeground).toBe("#1c1c1a");
    for (const brand of [
      "#5e6ad2",
      "#3ea6ff",
      "#e11d48",
      "#16a34a",
      "#facc15",
    ]) {
      const p = derivePalette(brand, "light");
      expect(
        contrast(p?.accentForeground ?? "", p?.accentSolid ?? ""),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the accent text clears AA on the theme's lightest surface", () => {
    for (const brand of [
      "#ffffff",
      "#000000",
      "#5e6ad2",
      "#facc15",
      "#1e3a8a",
    ]) {
      for (const theme of ["dark", "light"] as const) {
        const p = derivePalette(brand, theme);
        expect(
          contrast(p?.accent ?? "", SURFACE[theme]),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("an already-legible brand color is kept as the text color", () => {
    expect(derivePalette("#1d4ed8", "light")?.accent).toBe("#1d4ed8");
  });

  test("the soft tint is a translucent wash of the fill", () => {
    expect(derivePalette("#2563eb", "dark")?.accentSoft).toBe(
      "rgba(37, 99, 235, 0.2)",
    );
    expect(derivePalette("#2563eb", "light")?.accentSoft).toBe(
      "rgba(37, 99, 235, 0.12)",
    );
  });
});

describe("resolveBrandTokens (ADVANCED tokens saved before the split)", () => {
  test("a single accent also becomes the fill", () => {
    expect(
      resolveBrandTokens({ accent: "#e11d48", accentHover: "#be123c" }),
    ).toEqual({
      accent: "#e11d48",
      accentHover: "#be123c",
      accentSolid: "#e11d48",
      accentSolidHover: "#be123c",
      accentForeground: "#ffffff",
    });
  });

  test("a light accent gets dark text on its fill, not the white default", () => {
    expect(resolveBrandTokens({ accent: "#ffffff" }).accentForeground).toBe(
      "#1c1c1a",
    );
    expect(resolveBrandTokens({ accent: "#fde047" }).accentForeground).toBe(
      "#1c1c1a",
    );
    expect(resolveBrandTokens({ accent: "#fff" }).accentForeground).toBe(
      "#1c1c1a",
    );
  });

  test("a foreground the brand set is kept", () => {
    expect(
      resolveBrandTokens({ accent: "#ffffff", accentForeground: "#111111" })
        .accentForeground,
    ).toBe("#111111");
  });

  test("a functional color is read through the caller's resolver", () => {
    const toHex = (c: string) =>
      c === "oklch(0.97 0.02 90)" ? "#fbf6e8" : null;
    expect(
      resolveBrandTokens({ accent: "oklch(0.97 0.02 90)" }, toHex)
        .accentForeground,
    ).toBe("#1c1c1a");
  });

  test("a color nothing can resolve keeps the default foreground", () => {
    expect(
      resolveBrandTokens({ accent: "oklch(0.9 0.1 90)" }).accentForeground,
    ).toBeUndefined();
  });

  test("an explicit fill is kept as set", () => {
    expect(
      resolveBrandTokens({ accent: "#fda4af", accentSolid: "#e11d48" }),
    ).toEqual({ accent: "#fda4af", accentSolid: "#e11d48" });
  });

  test("no accent, nothing to carry over", () => {
    expect(resolveBrandTokens({ accentSoft: "#e11d4833" })).toEqual({
      accentSoft: "#e11d4833",
    });
  });
});
