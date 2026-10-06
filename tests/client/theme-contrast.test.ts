import { describe, expect, test } from "bun:test";

// Reads the real stylesheet instead of a copy of the palette, so a token
// edited in public/index.css is what gets checked. A hardcoded table here would
// drift and the suite would keep passing on a palette that no longer exists.
const css = await Bun.file("public/index.css").text();

function extractBlock(header: string): string {
  const start = css.indexOf(header);
  if (start < 0)
    throw new Error(`Block not found in public/index.css: ${header}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`Unterminated block: ${header}`);
}

// Every `--color-*` declaration in a block, raw value untouched. Used to check
// that the value is a valid CSS color at all, and to resolve `*-soft` tokens
// for compositing below. `parseColors` (opaque hex only) stays the source for
// the contrast-ratio tables further down, since those only ever compare solid
// surfaces and text.
function extractAllColors(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--color-([\w-]+):\s*([^;]+);/g)) {
    const [, name, value] = match as unknown as [string, string, string];
    out[name] = value.trim();
  }
  return out;
}

// Only opaque hex values: the `*-soft` tokens carry an alpha channel and are
// composited separately below.
function parseColors(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(
    /--color-([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g,
  )) {
    const [, name, hex] = match as unknown as [string, string, string];
    out[name] = hex.toLowerCase();
  }
  return out;
}

// --- CSS color validation ---------------------------------------------------
// Not a full CSS grammar, but it distinguishes every color syntax this
// stylesheet is allowed to use from everything the browser would refuse,
// including malformed values that only differ from a valid one by a detail a
// looser check would miss (e.g. `rgb(232 103)`, two channels instead of
// three: a real color function name and balanced parens, but not a color).

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// CSS Color Module Level 3/4 extended keyword set, plus the two keywords that
// resolve outside the palette (`transparent`, `currentcolor`, checked by name
// elsewhere). Not exhaustive of every CSS <color> production (no system
// colors), but complete for named colors, which is what "recusar tudo que o
// navegador recusa... nomes" asks for.
const NAMED_COLORS = new Set([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
]);
const KEYWORD_COLOR = /^(transparent|currentcolor)$/i;

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const PERCENT_RE = /^-?\d+(?:\.\d+)?%$/;
const HUE_RE = /^-?\d+(?:\.\d+)?(deg|grad|rad|turn)?$/;

function isRgbChannel(v: string): boolean {
  if (PERCENT_RE.test(v))
    return Number.parseFloat(v) >= 0 && Number.parseFloat(v) <= 100;
  if (NUMBER_RE.test(v))
    return Number.parseFloat(v) >= 0 && Number.parseFloat(v) <= 255;
  return false;
}

function isAlphaValue(v: string): boolean {
  if (PERCENT_RE.test(v))
    return Number.parseFloat(v) >= 0 && Number.parseFloat(v) <= 100;
  if (NUMBER_RE.test(v))
    return Number.parseFloat(v) >= 0 && Number.parseFloat(v) <= 1;
  return false;
}

// Splits a color function's argument list into channels and an optional alpha, accepting only the
// two syntaxes CSS allows: legacy comma-separated channels with an optional 4th comma alpha
// (`rgb(232, 103, 103, 0.15)`), or modern space-separated channels with a slash alpha
// (`rgb(232 103 103 / 15%)`). A mix of the two is invalid CSS and returns `null`. `syntax` says
// which form matched, because the legacy form requires one unit across the channels and the
// modern one allows mixing them (CSS Color 4).
function splitFunctionArgs(inner: string): {
  channels: string[];
  alpha: string | null;
  syntax: "legacy" | "modern";
} | null {
  const slashIndex = inner.indexOf("/");
  if (slashIndex >= 0) {
    const channelsPart = inner.slice(0, slashIndex).trim();
    if (channelsPart.includes(",")) return null;
    const alpha = inner.slice(slashIndex + 1).trim();
    return {
      channels: channelsPart.split(/\s+/).filter(Boolean),
      alpha,
      syntax: "modern",
    };
  }
  if (inner.includes(",")) {
    const parts = inner.split(",").map((s) => s.trim());
    if (parts.length === 3)
      return { channels: parts, alpha: null, syntax: "legacy" };
    if (parts.length === 4)
      return {
        channels: parts.slice(0, 3),
        alpha: parts[3] ?? null,
        syntax: "legacy",
      };
    return null;
  }
  const parts = inner.trim().split(/\s+/).filter(Boolean);
  return parts.length === 3
    ? { channels: parts, alpha: null, syntax: "modern" }
    : null;
}

// Splits on a separator at nesting depth 0, so a color-mix() argument that is
// itself a function call (or a nested color-mix()) is not cut in half.
function splitTopLevel(s: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === separator && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim());
}

// Splits on whitespace at nesting depth 0, so a color-mix() component whose
// color is itself a function call (`rgb(232 103 103)`, a nested
// `color-mix()`) keeps its internal spaces intact and only the space before
// a trailing percentage is treated as a separator.
function splitTopLevelWhitespace(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// A color-mix() component is a <color> optionally followed by a
// <percentage>. Returns `null` when the component doesn't match that shape,
// so a color function or a nested color-mix() with internal spaces is never
// mistaken for extra components (splitting naively on every whitespace, as a
// prior version of this file did, cuts `rgb(232 103 103) 15%` into four
// pieces instead of two).
function splitColorMixComponent(
  component: string,
): { color: string; percentage: string | null } | null {
  const tokens = splitTopLevelWhitespace(component.trim());
  if (tokens.length === 1)
    return { color: tokens[0] as string, percentage: null };
  if (tokens.length === 2)
    return { color: tokens[0] as string, percentage: tokens[1] as string };
  return null;
}

function isValidRgb(inner: string): boolean {
  const parsed = splitFunctionArgs(inner);
  if (!parsed) return false;
  const { channels: ch, alpha, syntax } = parsed;
  if (ch.length !== 3) return false;
  if (!ch.every(isRgbChannel)) return false;
  // Only the legacy comma syntax requires the three channels to share one
  // unit category (all numbers or all percentages); the modern space syntax
  // explicitly permits mixing them (`rgb(232 40% 103)` is valid CSS, while
  // the comma-separated `rgba(232, 40%, 103, 0.1)` is not).
  if (syntax === "legacy") {
    const isPercent = ch.map((c) => PERCENT_RE.test(c));
    if (isPercent.some(Boolean) && !isPercent.every(Boolean)) return false;
  }
  return alpha === null || isAlphaValue(alpha);
}

function isValidHsl(inner: string): boolean {
  const parsed = splitFunctionArgs(inner);
  if (!parsed) return false;
  const { channels: ch, alpha } = parsed;
  if (ch.length !== 3) return false;
  const [h, s, l] = ch as [string, string, string];
  if (!HUE_RE.test(h)) return false;
  if (!PERCENT_RE.test(s) || !PERCENT_RE.test(l)) return false;
  if (
    Number.parseFloat(s) < 0 ||
    Number.parseFloat(s) > 100 ||
    Number.parseFloat(l) < 0 ||
    Number.parseFloat(l) > 100
  )
    return false;
  return alpha === null || isAlphaValue(alpha);
}

// `color-mix(in <space> [<hue-method>], <color> [<percentage>], <color> [<percentage>])`, each
// color validated recursively through `isValidCssColor`. A hue-interpolation method only exists
// for the polar spaces; pairing one with a rectangular space is invalid CSS a browser rejects.
const POLAR_COLOR_SPACES = new Set(["hsl", "hwb", "lch", "oklch"]);
const RECTANGULAR_COLOR_SPACES = new Set([
  "srgb",
  "srgb-linear",
  "lab",
  "oklab",
  "xyz",
  "xyz-d50",
  "xyz-d65",
]);

function isValidColorMix(inner: string): boolean {
  const parts = splitTopLevel(inner, ",");
  if (parts.length !== 3) return false;
  const [spacePart, comp1, comp2] = parts as [string, string, string];
  const spaceMatch = spacePart
    .trim()
    .match(
      /^in\s+([\w-]+)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?$/i,
    );
  if (!spaceMatch) return false;
  const space = spaceMatch[1]?.toLowerCase() ?? "";
  const hasHueMethod = spaceMatch[2] !== undefined;
  if (!POLAR_COLOR_SPACES.has(space) && !RECTANGULAR_COLOR_SPACES.has(space))
    return false;
  if (hasHueMethod && !POLAR_COLOR_SPACES.has(space)) return false;

  const percentages: number[] = [];
  const componentsValid = [comp1, comp2].every((component) => {
    const parsed = splitColorMixComponent(component);
    if (!parsed) return false;
    if (parsed.percentage !== null) {
      if (!PERCENT_RE.test(parsed.percentage)) return false;
      const value = Number.parseFloat(parsed.percentage);
      if (value < 0 || value > 100) return false;
      percentages.push(value);
    }
    return isValidCssColor(parsed.color);
  });
  if (!componentsValid) return false;
  // A combined weight of zero (both percentages explicit and both 0%) has no
  // defined mix result in the spec.
  if (percentages.length === 2 && percentages[0] === 0 && percentages[1] === 0)
    return false;
  return true;
}

function isValidCssColor(value: string): boolean {
  if (HEX_COLOR.test(value)) return true;
  const lower = value.toLowerCase();
  if (KEYWORD_COLOR.test(lower) || NAMED_COLORS.has(lower)) return true;
  const fn = value.match(/^([\w-]+)\((.*)\)$/s);
  if (!fn) return false;
  const [, name = "", inner = ""] = fn;
  switch (name.toLowerCase()) {
    case "rgb":
    case "rgba":
      return isValidRgb(inner);
    case "hsl":
    case "hsla":
      return isValidHsl(inner);
    case "color-mix":
      return isValidColorMix(inner);
    // hwb()/lab()/lch()/oklab()/oklch()/color() are not used anywhere in this
    // file; add a case above (with the matching branch in `resolveColor`)
    // before a token adopts one, rather than accepting it unchecked here.
    default:
      return false;
  }
}

function channels(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Fails loudly on a renamed/removed token instead of computing a ratio against
// `undefined`.
function color(palette: Record<string, string>, token: string): string {
  const hex = palette[token];
  if (!hex) {
    throw new Error(`--color-${token} is not defined in public/index.css`);
  }
  return hex;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

// --- Resolving any valid CSS color to the RGBA it actually paints ----------
// Used for `*-soft` compositing math. Supports every syntax `isValidCssColor`
// accepts except bare named colors and `currentcolor` (no token here uses a
// name, and `currentcolor` has no fixed value to resolve): hex (3/4/6/8),
// `transparent`, `rgb()`/`rgba()`, `hsl()`/`hsla()`, and `color-mix(in srgb,
// ...)`. A token that starts using a name or a different color-mix() space
// needs this extended first.

type Rgba = { r: number; g: number; b: number; a: number };

function hexDigitsToRgba(digits: string): Rgba {
  if (digits.length === 3 || digits.length === 4) {
    const expand = (c: string) => Number.parseInt(c + c, 16);
    const r = expand(digits[0] ?? "0");
    const g = expand(digits[1] ?? "0");
    const b = expand(digits[2] ?? "0");
    const a = digits.length === 4 ? expand(digits[3] ?? "f") / 255 : 1;
    return { r, g, b, a };
  }
  const [r, g, b] = channels(`#${digits.slice(0, 6)}`);
  const a =
    digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function toChannelByte(v: string): number {
  return v.endsWith("%")
    ? (Number.parseFloat(v) / 100) * 255
    : Number.parseFloat(v);
}

function toAlphaFraction(v: string): number {
  return v.endsWith("%") ? Number.parseFloat(v) / 100 : Number.parseFloat(v);
}

function resolveRgbFn(inner: string): Rgba {
  const parsed = splitFunctionArgs(inner);
  if (!parsed)
    throw new Error(
      `rgb()/rgba() has an invalid channel/alpha syntax: rgb(${inner})`,
    );
  const { channels: ch, alpha } = parsed;
  if (ch.length !== 3)
    throw new Error(`rgb()/rgba() needs exactly 3 channels: rgb(${inner})`);
  const [rStr, gStr, bStr] = ch as [string, string, string];
  return {
    r: Math.round(toChannelByte(rStr)),
    g: Math.round(toChannelByte(gStr)),
    b: Math.round(toChannelByte(bStr)),
    a: alpha === null ? 1 : toAlphaFraction(alpha),
  };
}

function hueToDegrees(v: string): number {
  const m = v.match(/^(-?\d+(?:\.\d+)?)(deg|grad|rad|turn)?$/);
  if (!m) throw new Error(`Cannot resolve hue: ${v}`);
  const [, numStr = "0", unit] = m;
  const n = Number.parseFloat(numStr);
  if (unit === "grad") return n * 0.9;
  if (unit === "rad") return (n * 180) / Math.PI;
  if (unit === "turn") return n * 360;
  return n;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r1, g1, b1] = [0, 0, 0];
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

function resolveHslFn(inner: string): Rgba {
  const parsed = splitFunctionArgs(inner);
  if (!parsed)
    throw new Error(
      `hsl()/hsla() has an invalid channel/alpha syntax: hsl(${inner})`,
    );
  const { channels: ch, alpha } = parsed;
  if (ch.length !== 3)
    throw new Error(`hsl()/hsla() needs exactly 3 channels: hsl(${inner})`);
  const [hStr, sStr, lStr] = ch as [string, string, string];
  const [r, g, b] = hslToRgb(
    hueToDegrees(hStr),
    Number.parseFloat(sStr) / 100,
    Number.parseFloat(lStr) / 100,
  );
  return { r, g, b, a: alpha === null ? 1 : toAlphaFraction(alpha) };
}

// CSS Color 4 `color-mix()` for a rectangular (non-hue-based) space: mixes in
// premultiplied form so a stop at 0% alpha (`transparent`) never bleeds its
// own hue into the result, matching the browser's algorithm exactly for `in
// srgb`. Other spaces (oklab, lch, ...) need hue-aware interpolation this
// does not implement, so they raise instead of silently computing the wrong
// color.
function mixColors(
  c1: Rgba,
  p1: number | null,
  c2: Rgba,
  p2: number | null,
): Rgba {
  let w1: number;
  let w2: number;
  if (p1 === null && p2 === null) {
    w1 = 50;
    w2 = 50;
  } else if (p1 === null) {
    w2 = p2 as number;
    w1 = 100 - w2;
  } else if (p2 === null) {
    w1 = p1;
    w2 = 100 - w1;
  } else {
    w1 = p1;
    w2 = p2;
  }
  const sum = w1 + w2;
  let alphaMultiplier = 1;
  if (sum !== 100) {
    alphaMultiplier = Math.min(1, sum / 100);
    w1 = (w1 / sum) * 100;
    w2 = (w2 / sum) * 100;
  }
  const f1 = w1 / 100;
  const f2 = w2 / 100;
  const mixedAlpha = c1.a * f1 + c2.a * f2;
  const mixChannel = (ch1: number, ch2: number) =>
    mixedAlpha === 0 ? 0 : (ch1 * c1.a * f1 + ch2 * c2.a * f2) / mixedAlpha;
  return {
    r: Math.round(mixChannel(c1.r, c2.r)),
    g: Math.round(mixChannel(c1.g, c2.g)),
    b: Math.round(mixChannel(c1.b, c2.b)),
    a: mixedAlpha * alphaMultiplier,
  };
}

function resolveColorMixFn(inner: string): Rgba {
  const parts = splitTopLevel(inner, ",");
  if (parts.length !== 3)
    throw new Error(
      `color-mix() needs "in <space>, <color>, <color>": color-mix(${inner})`,
    );
  const [spacePart, comp1, comp2] = parts as [string, string, string];
  const spaceMatch = spacePart.trim().match(/^in\s+([\w-]+)/i);
  if (spaceMatch?.[1]?.toLowerCase() !== "srgb") {
    throw new Error(
      `Contrast math only resolves color-mix(in srgb, ...): color-mix(${inner})`,
    );
  }
  const parseComponent = (component: string): [Rgba, number | null] => {
    const parsed = splitColorMixComponent(component);
    if (!parsed)
      throw new Error(`color-mix() component is malformed: ${component}`);
    return [
      resolveColor(parsed.color),
      parsed.percentage === null ? null : Number.parseFloat(parsed.percentage),
    ];
  };
  const [c1, p1] = parseComponent(comp1);
  const [c2, p2] = parseComponent(comp2);
  if (p1 === 0 && p2 === 0) {
    throw new Error(
      `color-mix() with both percentages at 0% has no defined mix: color-mix(${inner})`,
    );
  }
  return mixColors(c1, p1, c2, p2);
}

function resolveColor(value: string): Rgba {
  const v = value.trim();
  if (v.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (HEX_COLOR.test(v)) return hexDigitsToRgba(v.slice(1));
  const fn = v.match(/^([\w-]+)\((.*)\)$/s);
  if (fn) {
    const [, name = "", inner = ""] = fn;
    const lname = name.toLowerCase();
    if (lname === "rgb" || lname === "rgba") return resolveRgbFn(inner);
    if (lname === "hsl" || lname === "hsla") return resolveHslFn(inner);
    if (lname === "color-mix") return resolveColorMixFn(inner);
  }
  throw new Error(
    `Contrast math does not resolve this color yet (supported: hex, transparent, rgb()/rgba(), hsl()/hsla(), color-mix(in srgb, ...)): ${value}`,
  );
}

// Alpha-composites `fg` (with its own alpha) over the opaque `bgHex` behind it,
// i.e. the pixel the browser actually paints for a `*-soft` background.
function compositeOver(fg: Rgba, bgHex: string): string {
  const [br, bgG, bb] = channels(bgHex);
  const mix = (f: number, b: number) =>
    Math.round(f * fg.a + b * (1 - fg.a))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(fg.r, br)}${mix(fg.g, bgG)}${mix(fg.b, bb)}`;
}

const darkBlock = extractBlock("@theme");
const lightBlock = extractBlock('html[data-theme="light"]');

const dark = parseColors(darkBlock);
const light = parseColors(lightBlock);
const THEMES = { dark, light } as const;

const darkAll = extractAllColors(darkBlock);
const lightAll = extractAllColors(lightBlock);
const ALL_THEMES = { dark: darkAll, light: lightAll } as const;

const SURFACES = ["bg-primary", "bg-secondary", "bg-tertiary", "bg-hover"];
// The three surfaces every semantic status/accent color (not general body
// text, not a border) is checked against. `bg-hover` is deliberately excluded
// here, same as it already was for `error`/`warning`/`success`/`accent`
// below: it is a row-hover/press highlight, never a resting surface a status
// color or its soft tint sits on.
const STATUS_SURFACES = ["bg-primary", "bg-secondary", "bg-tertiary"];

// AA for normal text. Each entry says which surfaces the token is actually used
// on, so a threshold is never asserted for a combination the UI never renders.
const TEXT_TOKENS: { token: string; surfaces: string[]; min: number }[] = [
  { token: "text-primary", surfaces: SURFACES, min: 4.5 },
  { token: "text-secondary", surfaces: SURFACES, min: 4.5 },
  { token: "text-muted", surfaces: SURFACES, min: 4.5 },
  // Inputs and textareas render on bg-tertiary; that is the only surface a
  // placeholder ever sits on.
  { token: "text-placeholder", surfaces: ["bg-tertiary"], min: 4.5 },
  // Form field errors, `role="alert"` lines and the danger button's label.
  { token: "error", surfaces: STATUS_SURFACES, min: 4.5 },
  // Link and label text; pages and cards only.
  { token: "accent", surfaces: ["bg-primary", "bg-secondary"], min: 4.5 },
  // <Badge variant="success|warning"> renders these as text.
  { token: "success", surfaces: STATUS_SURFACES, min: 4.5 },
  { token: "warning", surfaces: STATUS_SURFACES, min: 4.5 },
  // <Badge variant="purple"> (the super admin role) renders it as text.
  { token: "purple", surfaces: STATUS_SURFACES, min: 4.5 },
];

// 3:1 is the WCAG minimum for graphical objects.
const GRAPHIC_TOKENS: { token: string; surfaces: string[]; min: number }[] = [
  { token: "border-focus", surfaces: SURFACES, min: 3 },
];

// Text drawn on a filled control rather than on a surface: the primary
// button, the skip link and the Tabs count pill all put `accent-foreground`
// on `accent-solid`. Kept apart from TEXT_TOKENS because the background here
// is not one of the surfaces.
const ON_FILL: { token: string; fill: string; min: number }[] = [
  { token: "accent-foreground", fill: "accent-solid", min: 4.5 },
  // NOTE: the same label stays on screen while the button is hovered.
  { token: "accent-foreground", fill: "accent-solid-hover", min: 4.5 },
];

// text-X (or icon-X) over X-soft's tint, measured against what the browser paints: the soft token's
// declared RGBA composited over the surface behind it, so a tint that drifts in hue or alpha is
// caught here. Every token with a `*-soft` counterpart gets a row at its plain color's threshold:
// 4.5 for accent/error/success/warning/purple on STATUS_SURFACES (a <Badge> renders each as text on
// its tint), and info mirrors accent.
const SOFT_ON_SURFACE: {
  text: string;
  soft: string;
  surfaces: string[];
  min: number;
}[] = [
  { text: "accent", soft: "accent-soft", surfaces: STATUS_SURFACES, min: 4.5 },
  { text: "info", soft: "info-soft", surfaces: STATUS_SURFACES, min: 4.5 },
  { text: "error", soft: "error-soft", surfaces: STATUS_SURFACES, min: 4.5 },
  {
    text: "purple",
    soft: "purple-soft",
    surfaces: STATUS_SURFACES,
    min: 4.5,
  },
  {
    text: "success",
    soft: "success-soft",
    surfaces: STATUS_SURFACES,
    min: 4.5,
  },
  {
    text: "warning",
    soft: "warning-soft",
    surfaces: STATUS_SURFACES,
    min: 4.5,
  },
];

// The soft-on-surface pair is the one combination in this file whose actual
// on-screen contrast depends on the browser's own alpha-compositing rounding,
// not just on the two declared hex values, so a value that clears its
// threshold by a hundredth or two is one rounding step away from failing in a
// real browser. Requiring headroom here (and only here) keeps that margin
// from being closed by a future edit that only re-checks the bare threshold.
const CANVAS_ROUNDING_MARGIN = 0.1;

// A `*-soft` background that composites to within this many 0-255 levels of
// the bare surface on every channel is not a visible tint, it is the surface
// with rounding noise: the same failure the issue reports (an alpha low
// enough that `bg-*-soft` paints nothing a user would notice). 8 is not a
// perceptual-uniformity constant, it is a floor well above what compositing
// rounding alone produces, so a `*-soft` alpha cannot collapse toward zero
// again without this failing even if some surface still clears contrast.
const MIN_VISIBLE_DELTA = 8;

function maxChannelDelta(hexA: string, hexB: string): number {
  const [ar, ag, ab] = channels(hexA);
  const [br, bg, bb] = channels(hexB);
  return Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb));
}

describe.each(Object.entries(ALL_THEMES))(
  "%s theme tokens",
  (_name, tokens) => {
    test.each(Object.entries(tokens))(
      "--color-%s is a valid CSS color",
      (token, value) => {
        expect(isValidCssColor(value), `--color-${token}: ${value}`).toBe(true);
      },
    );

    test("every *-soft token paints a non-transparent background", () => {
      const softTokens = Object.entries(tokens).filter(([name]) =>
        name.endsWith("-soft"),
      );
      expect(softTokens.length).toBeGreaterThan(0);
      for (const [name, value] of softTokens) {
        const { a } = resolveColor(value);
        expect(a, `--color-${name}: ${value}`).toBeGreaterThan(0);
      }
    });
  },
);

describe.each(Object.entries(THEMES))("%s theme", (_name, palette) => {
  test("every token the audit covers is defined", () => {
    for (const { token } of [...TEXT_TOKENS, ...GRAPHIC_TOKENS]) {
      expect(palette[token], `--color-${token}`).toBeDefined();
    }
    for (const surface of SURFACES) {
      expect(palette[surface], `--color-${surface}`).toBeDefined();
    }
  });

  // NOTE: `bg-tertiary` is a fill drawn ON the other two surfaces (skeletons
  // and wells on the panel, hover on the sidebar), so it has to read as
  // different from both. A light theme with secondary and tertiary both white
  // made every skeleton inside a card invisible. 1.05 is below the dark
  // theme's tightest pair (1.07), which reads fine on screen.
  test.each(["bg-primary", "bg-secondary"])(
    "bg-tertiary is distinguishable on %s",
    (surface) => {
      const fill = color(palette, "bg-tertiary");
      const bg = color(palette, surface);
      expect(
        Number(contrast(fill, bg).toFixed(3)),
        `--color-bg-tertiary (${fill}) on --color-${surface} (${bg})`,
      ).toBeGreaterThanOrEqual(1.05);
    },
  );

  test.each([...TEXT_TOKENS, ...GRAPHIC_TOKENS])(
    "$token clears $min:1 on $surfaces",
    ({ token, surfaces, min }) => {
      for (const surface of surfaces) {
        const fg = color(palette, token);
        const bg = color(palette, surface);
        expect(
          Number(contrast(fg, bg).toFixed(2)),
          `--color-${token} (${fg}) on --color-${surface} (${bg})`,
        ).toBeGreaterThanOrEqual(min);
      }
    },
  );

  test.each(ON_FILL)(
    "$token clears $min:1 on $fill",
    ({ token, fill, min }) => {
      const fg = color(palette, token);
      const bg = color(palette, fill);
      expect(
        Number(contrast(fg, bg).toFixed(2)),
        `--color-${token} (${fg}) on --color-${fill} (${bg})`,
      ).toBeGreaterThanOrEqual(min);
    },
  );

  test.each(SOFT_ON_SURFACE)(
    "$text text clears $min:1 (+ rounding margin) over its own soft background",
    ({ text, soft, surfaces, min }) => {
      const fg = color(palette, text);
      const softValue = ALL_THEMES[_name as keyof typeof ALL_THEMES][soft];
      if (!softValue) {
        throw new Error(`--color-${soft} is not defined in public/index.css`);
      }
      const softRgba = resolveColor(softValue);
      for (const surface of surfaces) {
        const tinted = compositeOver(softRgba, color(palette, surface));
        expect(
          Number(contrast(fg, tinted).toFixed(2)),
          `--color-${text} (${fg}) on --color-${soft} (${softValue}) over --color-${surface}`,
        ).toBeGreaterThanOrEqual(min + CANVAS_ROUNDING_MARGIN);
      }
    },
  );

  // Independent of the text/background pairing above: a `*-soft` token has to
  // paint a visibly different pixel than the bare surface on its own, or the
  // tint the issue asks for does not exist regardless of what passes over it.
  test.each(SOFT_ON_SURFACE.map(({ soft, surfaces }) => ({ soft, surfaces })))(
    "$soft is visibly different from the bare surface ($surfaces)",
    ({ soft, surfaces }) => {
      const softValue = ALL_THEMES[_name as keyof typeof ALL_THEMES][soft];
      if (!softValue) {
        throw new Error(`--color-${soft} is not defined in public/index.css`);
      }
      const softRgba = resolveColor(softValue);
      for (const surface of surfaces) {
        const bg = color(palette, surface);
        const tinted = compositeOver(softRgba, bg);
        expect(
          maxChannelDelta(tinted, bg),
          `--color-${soft} (${softValue}) over --color-${surface} (${bg}) painted ${tinted}, too close to the bare surface`,
        ).toBeGreaterThanOrEqual(MIN_VISIBLE_DELTA);
      }
    },
  );
});

// Regression coverage for the color-validity and contrast-math helpers
// themselves, independent of whatever public/index.css currently declares.
// Pinned here because both bugs are the kind that hides behind a palette that
// happens not to exercise them: a validator that is too permissive, or a
// resolver that cannot handle a syntax the file does not (yet) use, only ever
// shows up the day a token's value changes shape.
describe("isValidCssColor", () => {
  test("rejects the Tailwind opacity-modifier syntax", () => {
    expect(isValidCssColor("#e86767/15")).toBe(false);
  });

  test("rejects rgb()/rgba() with the wrong channel count", () => {
    expect(isValidCssColor("rgb(232 103)")).toBe(false);
    expect(isValidCssColor("rgb(232, 103)")).toBe(false);
    expect(isValidCssColor("rgba(232, 103, 103, 0.15, 1)")).toBe(false);
  });

  test("accepts rgb()/rgba() in both legacy and modern syntax", () => {
    expect(isValidCssColor("rgb(232, 103, 103)")).toBe(true);
    expect(isValidCssColor("rgba(232, 103, 103, 0.15)")).toBe(true);
    expect(isValidCssColor("rgb(232 103 103)")).toBe(true);
    expect(isValidCssColor("rgb(232 103 103 / 15%)")).toBe(true);
  });

  test("accepts hsl()/hsla() and rejects a malformed one", () => {
    expect(isValidCssColor("hsl(210 50% 50%)")).toBe(true);
    expect(isValidCssColor("hsla(210, 50%, 50%, 0.5)")).toBe(true);
    expect(isValidCssColor("hsl(210 50%)")).toBe(false);
    expect(isValidCssColor("hsl(210 50 50)")).toBe(false); // s/l need "%"
  });

  test("accepts the color-mix() syntax the issue itself proposes", () => {
    expect(
      isValidCssColor("color-mix(in srgb, #e86767 15%, transparent)"),
    ).toBe(true);
  });

  test("rejects mixing legacy and modern rgb()/hsl() separators", () => {
    // Space-separated channels require a slash before alpha; a trailing
    // space-separated value with no slash is not valid CSS.
    expect(isValidCssColor("rgb(232 103 103 0.15)")).toBe(false);
    // The slash form is modern-syntax only: comma-separated channels next to
    // a slash-separated alpha is not valid CSS either.
    expect(isValidCssColor("rgb(232, 103, 103 / 15%)")).toBe(false);
  });

  test("accepts a color-mix() component whose color is itself a function call", () => {
    expect(
      isValidCssColor("color-mix(in srgb, rgb(232 103 103) 15%, transparent)"),
    ).toBe(true);
    expect(
      isValidCssColor(
        "color-mix(in srgb, color-mix(in srgb, red, blue) 50%, green)",
      ),
    ).toBe(true);
  });

  test("accepts named colors and rejects an unknown name", () => {
    expect(isValidCssColor("red")).toBe(true);
    expect(isValidCssColor("transparent")).toBe(true);
    expect(isValidCssColor("reddish")).toBe(false);
    expect(isValidCssColor("notacolor(1,2,3)")).toBe(false);
  });

  test("rejects mixed number/percentage channels only in the legacy comma syntax", () => {
    // Legacy: the comma list must be all one unit.
    expect(isValidCssColor("rgba(232, 40%, 103, 0.1)")).toBe(false);
    // Modern: CSS Color 4 explicitly allows mixing them.
    expect(isValidCssColor("rgb(232 40% 103)")).toBe(true);
    expect(isValidCssColor("rgb(90% 40% 40%)")).toBe(true);
  });

  test("rejects a hue-interpolation method on a rectangular color-mix() space", () => {
    expect(
      isValidCssColor(
        "color-mix(in srgb longer hue, #e86767 10%, transparent)",
      ),
    ).toBe(false);
    // The same modifier is valid CSS on a polar space.
    expect(
      isValidCssColor("color-mix(in hsl longer hue, red 50%, blue 50%)"),
    ).toBe(true);
  });

  test("rejects an unknown color-mix() interpolation space", () => {
    expect(isValidCssColor("color-mix(in madeupspace, red, blue)")).toBe(false);
  });

  test("rejects color-mix() percentages outside 0-100%", () => {
    expect(isValidCssColor("color-mix(in srgb, red 150%, blue)")).toBe(false);
    expect(isValidCssColor("color-mix(in srgb, red -20%, blue)")).toBe(false);
  });

  test("rejects color-mix() with both percentages explicitly at 0%", () => {
    expect(isValidCssColor("color-mix(in srgb, red 0%, blue 0%)")).toBe(false);
  });
});

describe("resolveColor", () => {
  test("resolves color-mix(in srgb, ...) to the same RGBA as the equivalent hex8", () => {
    // 0x26/255 only approximates 15% (rounded to the nearest byte, ~14.9%),
    // so the alpha is compared with tolerance while the RGB channels (exact
    // either way) are compared directly.
    const mixed = resolveColor("color-mix(in srgb, #e86767 15%, transparent)");
    const hex8 = resolveColor("#e8676726");
    expect({ r: mixed.r, g: mixed.g, b: mixed.b }).toEqual({
      r: hex8.r,
      g: hex8.g,
      b: hex8.b,
    });
    expect(mixed.a).toBeCloseTo(hex8.a, 2);
  });

  test("resolves rgb()/rgba() and hsl()/hsla() to the expected channels", () => {
    expect(resolveColor("rgb(232, 103, 103)")).toEqual({
      r: 232,
      g: 103,
      b: 103,
      a: 1,
    });
    expect(resolveColor("rgba(232, 103, 103, 0.15)")).toEqual({
      r: 232,
      g: 103,
      b: 103,
      a: 0.15,
    });
    expect(resolveColor("hsl(0 0% 100%)")).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 1,
    });
  });

  test("resolves a color-mix() component that is itself a function call", () => {
    const mixed = resolveColor(
      "color-mix(in srgb, rgb(232 103 103) 15%, transparent)",
    );
    const hex8 = resolveColor("#e8676726");
    expect({ r: mixed.r, g: mixed.g, b: mixed.b }).toEqual({
      r: hex8.r,
      g: hex8.g,
      b: hex8.b,
    });
    expect(mixed.a).toBeCloseTo(hex8.a, 2);
  });

  test("throws instead of dividing by zero on a color-mix() with both percentages at 0%", () => {
    expect(() =>
      resolveColor("color-mix(in srgb, #e86767 0%, #000000 0%)"),
    ).toThrow(/has no defined mix/);
  });
});
