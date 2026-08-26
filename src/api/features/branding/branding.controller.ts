import { Elysia, t } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { doc, errors, jsonResponse } from "@/api/lib/openapi";
import {
  clearBrandingAsset,
  setBrandingAsset,
  updateBrandingColors,
} from "./branding.admin.service";
import { getGlobalBranding, readBrandingAsset } from "./branding.service";

// GLOBAL identity/branding transport. Reads (the config + the binary assets) are PUBLIC — they
// must load before any auth/tenant context (login/setup pages, the favicon). Writes are gated to
// SUPER_ADMIN (identity is fleet-level, not tenant-level). Mounted under the /api group.
const variantParams = t.Object({
  kind: t.Union([t.Literal("logo"), t.Literal("favicon")], {
    description: 'Asset kind: accepts "logo" or "favicon".',
  }),
  variant: t.Union([t.Literal("dark"), t.Literal("light")], {
    description: 'Theme variant: accepts "dark" or "light".',
  }),
});

export const brandingController = new Elysia({
  prefix: "/v1/branding",
  tags: ["Settings"],
})
  .use(authPlugin)
  // Public: the resolved global identity (colors + which asset variants exist + cache version).
  // no-store: this config changes on every branding edit and the client re-fetches after each
  // mutation (e.g. removing a logo) — a heuristically-cached stale copy would point the UI at an
  // asset that no longer exists (broken/empty logo). The binary assets stay long-cached (?v=).
  .get(
    "/",
    ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return getGlobalBranding();
    },
    {
      detail: {
        ...doc(
          "Get global branding",
          "Returns the resolved global identity: colors, which asset variants exist, and the cache version. Public so it can load before any auth context.",
        ),
        security: [],
        responses: {
          200: jsonResponse(
            "The resolved global branding: brand name, color mode and tokens, which logo/favicon variants exist, and the cache-busting version.",
          ),
        },
      },
    },
  )
  // Public: serve a logo/favicon binary. Hardened headers neutralize a directly-opened SVG and
  // the version query (?v=) makes the long-lived cache safe to bust on change.
  .get(
    "/asset/:kind/:variant",
    async ({ params, set }) => {
      const asset = await readBrandingAsset(params.kind, params.variant);
      if (!asset) {
        set.status = 404;
        return { error: "Not Found" };
      }
      return new Response(
        new Blob([asset.bytes], { type: asset.contentType }),
        {
          headers: {
            "content-type": asset.contentType,
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
        },
      );
    },
    {
      params: variantParams,
      detail: {
        ...doc(
          "Get branding asset",
          "Serves a logo or favicon binary for the given kind and theme variant, long-cached and busted via the ?v= query. Public so assets load before any auth context.",
        ),
        security: [],
      },
      response: errors(400, 404, 422),
    },
  )
  // SUPER_ADMIN: update colors (mode + brand color and/or per-theme token maps).
  .patch("/", ({ body }) => updateBrandingColors(body), {
    requireRole: "SUPER_ADMIN",
    body: t.Object({
      brandName: t.Optional(
        t.Union([t.String({ maxLength: 128 }), t.Null()], {
          description: "Display brand name, or null to clear it.",
        }),
      ),
      colorMode: t.Optional(
        t.Union([t.Literal("SIMPLE"), t.Literal("ADVANCED")], {
          description:
            'Color editing mode: "SIMPLE" (single brand color) or "ADVANCED" (full token maps).',
        }),
      ),
      brandColor: t.Optional(
        t.Union([t.String({ maxLength: 64 }), t.Null()], {
          description:
            "Primary brand color (CSS color string), or null to clear it.",
        }),
      ),
      tokensLight: t.Optional(
        t.Record(t.String(), t.Unknown(), {
          description: "Light-theme CSS token overrides keyed by token name.",
        }),
      ),
      tokensDark: t.Optional(
        t.Record(t.String(), t.Unknown(), {
          description: "Dark-theme CSS token overrides keyed by token name.",
        }),
      ),
      siteUrl: t.Optional(
        t.Union([t.String({ maxLength: 512 }), t.Null()], {
          description:
            "Sidebar-footer website link (absolute http(s) URL), or null to use the default.",
        }),
      ),
      supportEmail: t.Optional(
        t.Union([t.String({ maxLength: 254 }), t.Null()], {
          description:
            "Support e-mail shown in the sidebar support modal, or null to use the default.",
        }),
      ),
      hideGithubLink: t.Optional(
        t.Boolean({
          description:
            "When true, the GitHub entry is removed from the sidebar footer.",
        }),
      ),
    }),
    detail: doc(
      "Update branding colors",
      "Updates the global branding color mode, brand color, and per-theme token maps. SUPER_ADMIN only.",
    ),
    response: errors(400, 401, 403, 422),
  })
  // SUPER_ADMIN: upload a logo/favicon variant (multipart). The service re-checks type + size.
  .put(
    "/asset/:kind/:variant",
    ({ params, body }) =>
      setBrandingAsset(params.kind, params.variant, body.file),
    {
      requireRole: "SUPER_ADMIN",
      params: variantParams,
      // NOTE: type is NOT validated here — Elysia's t.File type check sniffs magic bytes, which
      // SVG (text/XML) has none of, so it would reject legitimate SVGs. The service validates the
      // (declared) MIME against an explicit allowlist AND re-checks the per-kind size, returning
      // localized errors. The 2m cap is a coarse upper bound above the service's per-kind limits.
      body: t.Object({
        file: t.File({
          maxSize: "2m",
          description:
            "Logo or favicon file (multipart). MIME and per-kind size are re-validated server-side.",
        }),
      }),
      detail: doc(
        "Upload branding asset",
        "Uploads a logo or favicon binary for the given kind and theme variant (multipart). SUPER_ADMIN only.",
      ),
      response: errors(400, 401, 403, 422),
    },
  )
  // SUPER_ADMIN: remove a logo/favicon variant.
  .delete(
    "/asset/:kind/:variant",
    ({ params }) => clearBrandingAsset(params.kind, params.variant),
    {
      requireRole: "SUPER_ADMIN",
      params: variantParams,
      detail: doc(
        "Delete branding asset",
        "Removes the stored logo or favicon binary for the given kind and theme variant. SUPER_ADMIN only.",
      ),
      response: errors(400, 401, 403, 422),
    },
  );
