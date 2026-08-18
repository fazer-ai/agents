import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundAuthStrategy } from "@/../generated/prisma/client";
import { getCatalogEntry } from "@/modules/integrations/catalog";

// Per-instance inbound auth, verified AFTER the route token has resolved the tenant (so the
// secret read is tenant-scoped and a bad signature for a real token still fails uniformly).
// Header names default sensibly but are overridable per instance via config, because external
// providers dictate their own (e.g. Asaas sends `asaas-access-token`).

export const DEFAULT_STATIC_HEADER = "x-webhook-token";
export const DEFAULT_SIGNATURE_HEADER = "x-webhook-signature";

export interface InboundAuthConfig {
  authHeader?: string;
  signatureHeader?: string;
}

// Which header carries the credential for this instance. Precedence, most specific first: the
// operator's per-instance override, then the provider's own convention from the catalog, then our
// generic default. The middle layer is the one issue #107 was missing — a provider that fixes its
// header name (Asaas: `asaas-access-token`) leaves the operator nothing to change on their side, so
// the generic default rejected every delivery and the failure was visible only in the provider's
// own queue.
export function resolveInboundAuthConfig(
  catalogType: string,
  config: Record<string, unknown>,
): Required<InboundAuthConfig> {
  const entry = getCatalogEntry(catalogType);
  const override = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  return {
    authHeader:
      override(config.authHeader) ??
      entry?.inboundAuthHeader ??
      DEFAULT_STATIC_HEADER,
    signatureHeader:
      override(config.signatureHeader) ?? DEFAULT_SIGNATURE_HEADER,
  };
}

function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// `getHeader` is case-insensitive in callers (Headers.get); strategy NONE always passes.
// HMAC material is the raw body; an optional `sha256=` prefix is stripped before compare.
export function verifyInboundAuth(params: {
  strategy: InboundAuthStrategy;
  secret: string | null;
  rawBody: string;
  getHeader: (name: string) => string | null;
  config?: InboundAuthConfig;
}): boolean {
  const { strategy, secret, rawBody, getHeader, config } = params;

  if (strategy === "NONE") return true;
  if (!secret) return false; // a secret-bearing strategy with no configured secret fails closed

  if (strategy === "STATIC_HEADER") {
    const headerName = config?.authHeader ?? DEFAULT_STATIC_HEADER;
    const provided = getHeader(headerName);
    return provided !== null && timingEqual(provided, secret);
  }

  if (strategy === "HMAC_SHA256") {
    const headerName = config?.signatureHeader ?? DEFAULT_SIGNATURE_HEADER;
    const provided = getHeader(headerName);
    if (provided === null) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const stripped = provided.startsWith("sha256=")
      ? provided.slice("sha256=".length)
      : provided;
    return timingEqual(expected, stripped);
  }

  return false;
}
