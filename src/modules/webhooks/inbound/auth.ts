import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundAuthStrategy } from "@/../generated/prisma/client";
import { getCatalogEntry } from "@/modules/integrations/catalog";
import type { VaultRefResolution } from "@/modules/vault/service";

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
  // A string is the operator's answer, whatever it says — `""` included. Dropping the empty one here
  // sent the gate the DEFAULT name, which is the single thing the refusal below exists to prevent:
  // comparing the secret against `x-webhook-token` on an instance whose operator asked for something
  // else. Judging usability is the gate's job, not this one's; here the question is only whether an
  // override was GIVEN.
  //
  // A non-string still falls through, and deliberately: it is not an answer to this question at all,
  // rows already carry it, and `verifyInboundAuth` would have nothing to compare it against.
  const override = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  return {
    authHeader:
      override(config.authHeader) ??
      entry?.inboundAuthHeader ??
      DEFAULT_STATIC_HEADER,
    signatureHeader:
      override(config.signatureHeader) ?? DEFAULT_SIGNATURE_HEADER,
  };
}

// A header NAME, by RFC 7230's `token`: the alphabet `Headers.get` accepts and nothing wider. The
// name reaching here is operator text — `config.authHeader` is a free-form JSON field with no
// allowlist on either writer — and `request.headers.get` THROWS on anything outside this, so before
// issue #362 a trailing space answered the delivery 500 while every other refusal answered 401. The
// status was then the oracle the uniform 401 exists to deny: 500 said "this token resolves to a live
// instance", where an unknown token still said 401.
//
// The write refuses this too (integrations/service.ts), and that does not make this redundant: rows
// already carry whatever they carry, and no write-side fix reaches a row already written.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isUsableHeaderName(name: string): boolean {
  return HEADER_NAME.test(name);
}

function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// How the instance's secret arrived, straight from the vault's own three-state answer, plus `null`
// for an instance that names no secret at all. It is the whole input to the gate below, and the
// reason it is a state rather than a `string | null` is issue #124: every one of these used to
// collapse into the same null, and therefore into the same 401.
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
// decrypts to a Record, which is truthy, so before this narrowed it reached Buffer.from/createHmac
// and threw, so a mis-wired secret answered 500 while a wrong token answered 401.
//
// The empty-string case is not decoration: the shipped guard was `if (!secret)`, which caught "" and
// null in one breath. Splitting the states splits that guard too, and "" has to stay fail-closed.
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
// HMAC material is the raw body; an optional `sha256=` prefix is stripped before compare.
export function verifyInboundAuth(params: {
  strategy: InboundAuthStrategy;
  secret: InboundSecretResolution;
  rawBody: string;
  getHeader: (name: string) => string | null;
  config?: InboundAuthConfig;
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
    const expected = createHmac("sha256", value).update(rawBody).digest("hex");
    const stripped = provided.startsWith("sha256=")
      ? provided.slice("sha256=".length)
      : provided;
    return timingEqual(expected, stripped)
      ? { ok: true }
      : fail("credential_mismatch");
  }

  return fail("unsupported_strategy");
}
