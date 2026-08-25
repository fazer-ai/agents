import prisma from "@/api/lib/prisma";
import config from "@/config";
import { sanitizeBranding } from "@/lib/branding";
import { clipText } from "@/lib/text";

// Global app identity/branding (a single row, id = 1). GLOBAL state — NOT tenant-scoped — so this
// uses the base prisma client directly (no runScoped). Reads are public; writes are gated to
// SUPER_ADMIN at the controller AND are Pro-only: the mutation logic lives in the paired
// branding.admin.service (Full) / branding.admin.service.free (Free stub, ABSENT-then-swapped). This
// module holds the read/type/const surface present in every edition. Logo/favicon binaries live on
// disk; the DB stores only the filename so the asset endpoint can resolve the file and infer its
// content-type.

// NOTE: these AppError translationKeys (thrown by branding.admin.service's write path) are localized
// centrally in `onError` (not via a literal translate() call), so they are declared here — in the
// shared module present in every edition — for the i18n extractor (keepRemoved: false).
// translate('errors.invalidColorMode', 'Invalid color mode')
// translate('errors.invalidColorToken', 'Invalid color value')
// translate('errors.unsupportedImageType', 'Unsupported image type. Allowed: {{allowed}}')
// translate('errors.imageTooLarge', 'Image is too large')
// translate('errors.noUpdatableFields', 'No updatable fields provided')
// translate('errors.invalidSiteUrl', 'Invalid website URL')
// translate('errors.invalidSupportEmail', 'Invalid support e-mail')

export const SINGLETON_ID = 1;

export type AssetKind = "logo" | "favicon";
export type AssetVariant = "dark" | "light";
export type ColorMode = "SIMPLE" | "ADVANCED";

// Upload limits and the curated content-type allowlist (the uploader is SUPER_ADMIN, but we still
// bound size + type and serve with hardening headers at the controller).
export const ASSET_MAX_BYTES: Record<AssetKind, number> = {
  logo: 1_048_576, // 1 MB
  favicon: 524_288, // 512 KB
};
export const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};
const TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

export const ALLOWED_ASSET_TYPES = Object.keys(EXT_BY_TYPE);

// The formats a refusal names, DERIVED from the map that decides them: the sentence and the
// allowlist cannot drift apart, and the two upload surfaces accept different sets (the document
// letterhead takes PNG and JPEG only), which is why the sentence carries the list instead of
// spelling one of them out.
export const ALLOWED_ASSET_FORMATS = [...new Set(Object.values(EXT_BY_TYPE))]
  .map((e) => e.toUpperCase())
  .join(", ");

export interface GlobalBrandingDto {
  // White-label display name (document title + auth-page footer). null = use the default.
  brandName: string | null;
  colorMode: ColorMode;
  brandColor: string | null;
  tokensLight: Record<string, string>;
  tokensDark: Record<string, string>;
  logo: { dark: boolean; light: boolean };
  favicon: { dark: boolean; light: boolean };
  // Sidebar-footer links (white-label): the operator's own site and support inbox, plus the
  // option to drop the GitHub entry. null = use the built-in defaults.
  siteUrl: string | null;
  supportEmail: string | null;
  hideGithubLink: boolean;
  // Epoch-ms string of the last write — the client appends it to asset URLs to bust caches
  // (the favicon especially is cached aggressively by browsers). "0" while still at defaults.
  version: string;
}

interface BrandingRow {
  brandName: string | null;
  colorMode: string;
  brandColor: string | null;
  tokensLight: unknown;
  tokensDark: unknown;
  logoDarkKey: string | null;
  logoLightKey: string | null;
  faviconDarkKey: string | null;
  faviconLightKey: string | null;
  siteUrl: string | null;
  supportEmail: string | null;
  hideGithubLink: boolean;
  updatedAt: Date;
}

export const DEFAULT_DTO: GlobalBrandingDto = {
  brandName: null,
  colorMode: "SIMPLE",
  brandColor: null,
  tokensLight: {},
  tokensDark: {},
  logo: { dark: false, light: false },
  favicon: { dark: false, light: false },
  siteUrl: null,
  supportEmail: null,
  hideGithubLink: false,
  version: "0",
};

// Defensive sanitize: single line, control chars stripped, bounded length. null when empty.
export function sanitizeBrandName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = Array.from(value.trim())
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  return cleaned ? clipText(cleaned, MAX_BRAND_NAME_LEN) : null;
}

const MAX_BRAND_NAME_LEN = 64;
const MAX_SITE_URL_LEN = 512;
const MAX_SUPPORT_EMAIL_LEN = 254;
// Deliberately loose (one @, no spaces, a dot in the domain): the goal is catching typos and
// copy-paste accidents, not RFC 5322 — the value only feeds a mailto: link and the support modal.
const SUPPORT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// null unless the value parses as an absolute http(s) URL within bounds. The footer renders the
// value inside an anchor href, so anything else (javascript:, data:, relative paths) must die here.
export function sanitizeSiteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SITE_URL_LEN) return null;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

export function sanitizeSupportEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SUPPORT_EMAIL_LEN) return null;
  return SUPPORT_EMAIL_RE.test(trimmed) ? trimmed : null;
}

export function toDto(row: BrandingRow): GlobalBrandingDto {
  return {
    brandName: sanitizeBrandName(row.brandName),
    colorMode: row.colorMode === "ADVANCED" ? "ADVANCED" : "SIMPLE",
    brandColor: row.brandColor,
    // Re-sanitize on read (defense in depth: never trust what's at rest).
    tokensLight: sanitizeBranding(row.tokensLight),
    tokensDark: sanitizeBranding(row.tokensDark),
    logo: { dark: row.logoDarkKey !== null, light: row.logoLightKey !== null },
    favicon: {
      dark: row.faviconDarkKey !== null,
      light: row.faviconLightKey !== null,
    },
    siteUrl: sanitizeSiteUrl(row.siteUrl),
    supportEmail: sanitizeSupportEmail(row.supportEmail),
    hideGithubLink: row.hideGithubLink === true,
    version: row.updatedAt.getTime().toString(),
  };
}

export async function getGlobalBranding(): Promise<GlobalBrandingDto> {
  const row = await prisma.appBranding.findUnique({
    where: { id: SINGLETON_ID },
  });
  return row ? toDto(row) : DEFAULT_DTO;
}

export interface ColorUpdate {
  brandName?: string | null;
  colorMode?: ColorMode;
  brandColor?: string | null;
  tokensLight?: Record<string, unknown>;
  tokensDark?: Record<string, unknown>;
  siteUrl?: string | null;
  supportEmail?: string | null;
  hideGithubLink?: boolean;
}

export function keyColumn(
  kind: AssetKind,
  variant: AssetVariant,
): "logoDarkKey" | "logoLightKey" | "faviconDarkKey" | "faviconLightKey" {
  if (kind === "logo")
    return variant === "dark" ? "logoDarkKey" : "logoLightKey";
  return variant === "dark" ? "faviconDarkKey" : "faviconLightKey";
}

export function assetPath(filename: string): string {
  return `${config.brandingStorageDir.replace(/\/$/, "")}/${filename}`;
}

export interface ServedAsset {
  bytes: ArrayBuffer;
  contentType: string;
}

export async function readBrandingAsset(
  kind: AssetKind,
  variant: AssetVariant,
): Promise<ServedAsset | null> {
  const row = await prisma.appBranding.findUnique({
    where: { id: SINGLETON_ID },
  });
  if (!row) return null;
  const filename = row[keyColumn(kind, variant)] as string | null;
  if (!filename) return null;
  const ext = filename.slice(filename.lastIndexOf(".") + 1);
  const contentType = TYPE_BY_EXT[ext];
  if (!contentType) return null;
  const file = Bun.file(assetPath(filename));
  if (!(await file.exists())) return null;
  return { bytes: await file.arrayBuffer(), contentType };
}
