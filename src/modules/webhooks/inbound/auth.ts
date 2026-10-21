import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundAuthStrategy } from "@/../generated/prisma/client";
import { getCatalogEntry } from "@/modules/integrations/catalog";
import type { VaultRefResolution } from "@/modules/vault/service";
import { isUsableHeaderName } from "./header-name";
import {
  isSignatureConfigProblem,
  parseSignatureConfig,
  parseSignatureParts,
  renderSignedMessage,
  timestampMs,
} from "./signed-message";

// Per-instance inbound auth, verified AFTER the route token has resolved the tenant (so the
// secret read is tenant-scoped and a bad signature for a real token still fails uniformly).
// Header names default sensibly but are overridable per instance via config, because external
// providers dictate their own (e.g. Asaas sends `asaas-access-token`).

export const DEFAULT_STATIC_HEADER = "x-webhook-token";
export const DEFAULT_SIGNATURE_HEADER = "x-webhook-signature";

export interface InboundAuthConfig {
  authHeader?: string;
  signatureHeader?: string;
  // What HMAC_SHA256 signs when it is not the raw body (./signed-message.ts). Unparsed here: the
  // gate parses it and fails closed on a shape the writer would refuse.
  signature?: unknown;
}

// Which header carries the credential for this instance. Precedence, most specific first: the
// operator's per-instance override, then the provider's own convention from the catalog, then our
// generic default. The middle layer matters because a provider that fixes its header name (Asaas:
// `asaas-access-token`) leaves the operator nothing to change on their side.
export function resolveInboundAuthConfig(
  catalogType: string,
  config: Record<string, unknown>,
): Required<Omit<InboundAuthConfig, "signature">> &
  Pick<InboundAuthConfig, "signature"> {
  const entry = getCatalogEntry(catalogType);
  // A string is the operator's answer, `""` included: dropping it would send the gate the
  // DEFAULT name, the one thing its refusal exists to prevent. Usability is the gate's call. A
  // non-string falls through: it is not an answer, and the gate would have nothing to compare.
  const override = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  return {
    authHeader:
      override(config.authHeader) ??
      entry?.inboundAuthHeader ??
      DEFAULT_STATIC_HEADER,
    signatureHeader:
      override(config.signatureHeader) ?? DEFAULT_SIGNATURE_HEADER,
    signature: config.signature,
  };
}

export { isUsableHeaderName };

function stripSha256(provided: string): string {
  return provided.startsWith("sha256=")
    ? provided.slice("sha256=".length)
    : provided;
}

function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// How the instance's secret arrived, straight from the vault's own three-state answer, plus `null`
// for an instance that names no secret at all. It is the whole input to the gate below; a state and
// not a `string | null`, so the server can tell these cases apart behind the same 401.
export type InboundSecretResolution = VaultRefResolution<unknown> | null;

// Why a delivery was refused. The response never carries this (see the caller: every failure is the
// same 401, with no oracle for which route tokens are live). It exists so the SERVER can say which
// of these happened, which is the difference between an operator finding a misconfiguration and
// staring at a 401 in someone else's delivery log.
export type InboundAuthFailure =
  | "secret_not_configured"
  | "secret_ref_unresolved"
  | "secret_pending"
  | "secret_unusable"
  | "header_name_unusable"
  | "header_missing"
  | "credential_mismatch"
  | "signature_config_unusable"
  | "signature_part_missing"
  | "signed_value_missing"
  | "timestamp_unusable"
  | "timestamp_stale"
  | "unsupported_strategy";

export type InboundAuthOutcome =
  | { ok: true }
  | { ok: false; reason: InboundAuthFailure };

const fail = (reason: InboundAuthFailure): InboundAuthOutcome => ({
  ok: false,
  reason,
});

// The secret has to become a non-empty string before any strategy can use it, and each way it fails
// to is a different thing for the operator to do: point the field somewhere real, fill the entry,
// or pick a credential of a shape this can use. A multi-field credential (langfuse, google_oauth)
// decrypts to a Record, which is truthy, so without this narrowing it reaches Buffer.from/createHmac
// and throws, and a mis-wired secret answers 500 where a wrong token answers 401.
//
// The empty-string case is not decoration: a plain `if (!secret)` guard catches "" and null in one
// breath, and splitting the states must keep "" fail-closed.
function readSecret(
  secret: InboundSecretResolution,
): { ok: true; value: string } | { ok: false; reason: InboundAuthFailure } {
  if (secret === null) return { ok: false, reason: "secret_not_configured" };
  if (secret.state === "not_found") {
    return { ok: false, reason: "secret_ref_unresolved" };
  }
  if (secret.state === "pending")
    return { ok: false, reason: "secret_pending" };
  const value = secret.value;
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "secret_unusable" };
  }
  return { ok: true, value };
}

// `getHeader` is case-insensitive in callers (Headers.get); strategy NONE always passes.
// HMAC material is the raw body unless `config.signature` says otherwise; an optional `sha256=`
// prefix is stripped before compare.
export function verifyInboundAuth(params: {
  strategy: InboundAuthStrategy;
  secret: InboundSecretResolution;
  rawBody: string;
  getHeader: (name: string) => string | null;
  // The webhook URL's query string. Absent ⇒ every parameter is absent.
  getQuery?: (name: string) => string | null;
  config?: InboundAuthConfig;
  now?: number;
}): InboundAuthOutcome {
  const { strategy, secret, rawBody, getHeader, config } = params;

  if (strategy === "NONE") return { ok: true };

  const resolved = readSecret(secret);
  if (!resolved.ok) return resolved;
  const value = resolved.value;

  if (strategy === "STATIC_HEADER") {
    const headerName = config?.authHeader ?? DEFAULT_STATIC_HEADER;
    // Refused, never fallen back from. Comparing the secret against `x-webhook-token` because the
    // configured name is unusable would authenticate on a header the operator never chose, which is
    // a worse failure than refusing: it makes a misconfigured instance answer 200 to a request the
    // provider never intended to be authenticated by that header.
    if (!isUsableHeaderName(headerName)) return fail("header_name_unusable");
    const provided = getHeader(headerName);
    if (provided === null) return fail("header_missing");
    return timingEqual(provided, value)
      ? { ok: true }
      : fail("credential_mismatch");
  }

  if (strategy === "HMAC_SHA256") {
    const headerName = config?.signatureHeader ?? DEFAULT_SIGNATURE_HEADER;
    if (!isUsableHeaderName(headerName)) return fail("header_name_unusable");
    const provided = getHeader(headerName);
    if (provided === null) return fail("header_missing");
    const signature = parseSignatureConfig(config?.signature);
    if (signature === undefined) {
      const expected = createHmac("sha256", value)
        .update(rawBody)
        .digest("hex");
      return timingEqual(expected, stripSha256(provided))
        ? { ok: true }
        : fail("credential_mismatch");
    }
    if (isSignatureConfigProblem(signature)) {
      return fail("signature_config_unusable");
    }
    const parts =
      signature.format === "parts"
        ? parseSignatureParts(provided)
        : new Map<string, string[]>();
    const candidates =
      signature.format === "parts"
        ? (parts.get(signature.signaturePart as string) ?? [])
        : [stripSha256(provided)];
    if (!candidates.length) return fail("signature_part_missing");
    if (signature.maxAgeSeconds !== null) {
      const raw = parts.get(signature.timestampPart as string)?.[0];
      const at = raw === undefined ? null : timestampMs(raw);
      if (at === null) return fail("timestamp_unusable");
      const age = Math.abs((params.now ?? Date.now()) - at);
      if (age > signature.maxAgeSeconds * 1000) return fail("timestamp_stale");
    }
    const message = renderSignedMessage(signature.groups, {
      rawBody,
      getHeader,
      getQuery: params.getQuery ?? (() => null),
      parts,
    });
    if (message === null) return fail("signed_value_missing");
    const expected = createHmac("sha256", value).update(message).digest("hex");
    return candidates.some((c) => timingEqual(expected, c.toLowerCase()))
      ? { ok: true }
      : fail("credential_mismatch");
  }

  return fail("unsupported_strategy");
}
