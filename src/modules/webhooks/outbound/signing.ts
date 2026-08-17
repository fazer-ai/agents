import { createHmac, timingSafeEqual } from "node:crypto";

// HMAC signature for our outbound webhooks. Scheme mirrors Chatwoot's inbound format for
// consistency: signature = "sha256=" + HMAC_SHA256(secret, `${timestamp}.${rawBody}`) in
// hex, with the unix-seconds timestamp sent alongside. Receivers verify the timestamp
// window (anti-replay) and recompute over the raw body.

export const SIGNATURE_HEADER = "x-fazerai-signature";
export const TIMESTAMP_HEADER = "x-fazerai-timestamp";
export const DELIVERY_HEADER = "x-fazerai-delivery";

// Compatibility window for the brand rename. These are the only renamed identifiers consumed
// OUTSIDE our code: operators wired their receivers against the old names, and we only ever EMIT
// them (nothing here reads them back). So every delivery carries BOTH sets, with identical values,
// until 2.0 drops the legacy ones.
export const LEGACY_SIGNATURE_HEADER = "x-secretaria-signature";
export const LEGACY_TIMESTAMP_HEADER = "x-secretaria-timestamp";
export const LEGACY_DELIVERY_HEADER = "x-secretaria-delivery";

export function signOutbound(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
  return `sha256=${mac}`;
}

export interface OutboundHeaderParams {
  contentType: string;
  // Stable dedupe key for the receiver; "test" for the manual test delivery.
  deliveryId: string;
  timestampSeconds: number;
  rawBody: string;
  // Absent/null → unsigned delivery: no signature and no timestamp go out.
  secret?: string | null;
}

// Builds the headers of an outbound POST. Every emit site goes through here, so the dual emission
// of the compatibility window cannot be forgotten at one of them, and 2.0 removes it in one edit.
export function outboundHeaders(
  params: OutboundHeaderParams,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": params.contentType,
    [DELIVERY_HEADER]: params.deliveryId,
    [LEGACY_DELIVERY_HEADER]: params.deliveryId,
  };
  if (params.secret) {
    const signature = signOutbound(
      params.secret,
      params.timestampSeconds,
      params.rawBody,
    );
    const timestamp = String(params.timestampSeconds);
    headers[SIGNATURE_HEADER] = signature;
    headers[TIMESTAMP_HEADER] = timestamp;
    headers[LEGACY_SIGNATURE_HEADER] = signature;
    headers[LEGACY_TIMESTAMP_HEADER] = timestamp;
  }
  return headers;
}

export function verifyOutboundSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
  signature: string,
): boolean {
  const expected = signOutbound(secret, timestampSeconds, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
