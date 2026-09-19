import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import { sanitizeErrorMessage } from "@/lib/redact";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { redactEndpoint } from "@/modules/audit/projection";
import { tryResolveVaultSecret } from "@/modules/vault/service";
import { outboundHeaders } from "@/modules/webhooks/outbound/signing";

// THE ONE PLACE THAT TURNS AN ALERT INTO AN HTTP REQUEST (issue #605).
//
// Two callers: the worker delivering a queued alert, and the console's Test button probing a channel
// before an incident does. They agree on everything that decides whether an alert ARRIVES — the
// decrypted URL, the SSRF guard, the signing secret, the body shape, the headers, the refusal to
// follow a redirect, the timeout — and differ only in what they do with the answer: the worker moves
// a row through DELIVERED / PENDING / DEAD, the probe hands the outcome to a person.
//
// It is one function rather than two because a test button that exercises a DIFFERENT path from the
// real send is worse than no button: it approves a channel whose alerts will never arrive, which is
// the failure the issue is about, one level up. This repo already has the other shape next door —
// `webhooks/outbound/test.ts` re-states the outbound worker's rules in its own words and the two are
// kept in step by hand — and the alerting module is where that cost is highest, because nothing
// downstream notices when this bus goes quiet.

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_LEN = 500;

// THE CHANNEL'S URL IS A SECRET, AND ONE FETCH ERROR QUOTES IT BACK (holdout of #605, s10).
//
// A Discord webhook URL embeds a bot token, which is why the column is an `encryptJson` blob and the
// DTO returns `scheme://host/…`. Bun's `UnexpectedRedirect` names the URL it was fetching, in full,
// and that string is what the worker stores in `alert_deliveries.last_error` — measured there on the
// base, so the leak predates this change — and what the new test route, the MCP tool and the console
// toast now put in front of an operator and into anything that logs a response.
//
// Every URL in the message is reduced to the same masked form the read already shows, and nothing
// else is touched: the neighbouring failures were characterised in the same holdout and none of them
// carries more than the host (`getaddrinfo ENOTFOUND <host>`, "Unable to connect", "unknown
// certificate verification error", "The operation timed out."). A host is what `redactEndpoint`
// keeps, so the advice the operator needs survives the redaction.
//
// TWO PASSES, AND THE FIRST ONE IS THE ONE THAT HAS TO BE RIGHT (review round 3).
//
// The exact destination is KNOWN here — it was just decrypted — so it is replaced by literal string
// match, which cannot be defeated by what a URL happens to contain. A regex alone can: the first
// version of this stopped at `]`, so `https://[2606:4700::1111]/hooks/private-token` matched only up
// to the bracket, failed to parse, collapsed to "…" and left `]/hooks/private-token` standing. The
// same hole opens on any path character the class excludes. Guessing where a URL ENDS is the wrong
// job to give the thing guarding a token.
//
// The regex is the backstop, for URLs this function does not know: a redirect TARGET the destination
// chose, or a second URL some future error text quotes. It now stops only at whitespace and quotes,
// and over-matching is harmless because every match is replaced by `scheme://host/…` regardless —
// trailing punctuation swept in with it is dropped by the same rewrite.
//
// It requires a scheme on purpose. A bare host in a DNS failure is not matched and stays readable,
// which is the difference between telling someone their hostname does not resolve and telling them
// "…".
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;

function maskUrlsIn(text: string, known?: string): string {
  const withoutKnown =
    known && known.length > 0
      ? text.split(known).join(redactEndpoint(known))
      : text;
  return withoutKnown.replace(URL_IN_TEXT, (u) => redactEndpoint(u));
}

// `sanitizeErrorMessage` rather than a bare cut: this string is stored in `last_error`, and the
// exceptions a delivery produces wrap what the remote endpoint answered. See issue #243 and the
// function's own header for why a NUL or an orphan surrogate costs the whole write. The masking runs
// FIRST, so the 500-character cut cannot leave half a token behind by truncating mid-URL.
export function alertErrMsg(err: unknown, url?: string): string {
  return sanitizeErrorMessage(
    maskUrlsIn(err instanceof Error ? err.message : String(err), url),
    MAX_ERROR_LEN,
  );
}

// What a send needs to know, whichever caller asked for it. `url` is the channel's stored blob, not
// a URL: it is decrypted here so the plaintext never sits in a caller's local.
export interface AlertSendTarget {
  // The dedupe key the receiver sees. A delivery row id for a real alert, "test" for a probe — the
  // same sentinel `webhooks/outbound/test.ts` uses, so a receiver can tell the two apart.
  deliveryId: string;
  type: string;
  url: string;
  secretRef: string | null;
  stage: string | null;
  level: string;
  summary: string;
  count: number;
}

export interface AlertSendDeps {
  // Injectable for tests — default to the real network / SSRF path / wall clock.
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<URL>;
  now?: () => number;
  requestTimeoutMs?: number;
}

// Where the send stopped. `url` and `secret` mean NOTHING left the process, which is the distinction
// both callers need and neither can recover from a status code: the worker turns a bad URL into a
// permanent failure (no retry can fix it) and the probe has to tell the operator the request was
// never made, rather than letting them hunt for it in the destination's logs.
export type AlertSendStop = "url" | "secret" | "request" | "response";

export interface AlertSendResult {
  ok: boolean;
  stoppedAt: AlertSendStop | null;
  // The status the DESTINATION answered, or null when no response was received.
  status: number | null;
  // Short technical reason on failure, null on success.
  error: string | null;
  // Whether the payload went out HMAC-signed.
  signed: boolean;
  // The channel names a signing secret and it did not resolve, so this went out unsigned. Separate
  // from `signed` on purpose: unsigned-because-none-configured and unsigned-because-the-credential-
  // is-gone are the same wire request and opposite operator problems.
  secretUnresolved: boolean;
  // Wall time of the request itself, null when none was made.
  durationMs: number | null;
}

// Discord-native markdown (its webhook expects `{ content }`); the generic webhook gets a versioned
// JSON envelope. Both carry the coalesced burst count, never message text/PII.
export function buildAlertBody(a: {
  type: string;
  stage: string | null;
  level: string;
  summary: string;
  count: number;
}): { rawBody: string; contentType: string } {
  const times = a.count > 1 ? ` (×${a.count})` : "";
  if (a.type === "discord") {
    const icon = a.level === "error" ? "🔴" : "🟠";
    const content = `${icon} **fazer.ai agents** \`${a.stage ?? "—"}\` ${a.level}${times}\n${a.summary}`;
    return {
      rawBody: JSON.stringify({ content: clipText(content, 1900) }),
      contentType: "application/json",
    };
  }
  return {
    rawBody: JSON.stringify({
      version: 1,
      type: "alert",
      stage: a.stage,
      level: a.level,
      count: a.count,
      summary: a.summary,
    }),
    contentType: "application/json",
  };
}

function stopped(
  stoppedAt: AlertSendStop,
  error: string,
  over: Partial<AlertSendResult> = {},
): AlertSendResult {
  return {
    ok: false,
    stoppedAt,
    status: null,
    error,
    signed: false,
    secretUnresolved: false,
    durationMs: null,
    ...over,
  };
}

// `ctx` scopes the vault read (RLS active). The worker passes a synthetic TENANT_ADMIN context for
// the delivery's own tenant (it claims cross-tenant and has no user); the route passes the caller's.
export async function sendAlert(
  base: PrismaClient,
  ctx: TenantContext,
  a: AlertSendTarget,
  deps: AlertSendDeps = {},
): Promise<AlertSendResult> {
  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  // Decrypt the channel URL and vet the target. A blocked or unparseable URL can never succeed, so
  // it is reported as its own stop rather than as a failed request: no retry recovers it, and the
  // operator reading the probe's answer needs to know nothing was sent.
  let url: string;
  try {
    url = decryptJson<string>(a.url);
    await assertSafe(url);
  } catch (err) {
    return stopped("url", alertErrMsg(err));
  }

  // Optional HMAC secret (generic webhook), resolved through a tenant-scoped read.
  let secret: string | null = null;
  if (a.secretRef && a.type === "webhook") {
    try {
      const ref = a.secretRef;
      secret = await runScopedOn(base, ctx, (db) =>
        tryResolveVaultSecret<string>(db, ref),
      );
    } catch (err) {
      return stopped(
        "secret",
        `secret resolution failed: ${alertErrMsg(err, url)}`,
      );
    }
  }
  // A ref that names nothing (deleted entry, or one still awaiting its value) comes back null rather
  // than throwing, and the send goes out UNSIGNED. That is the behaviour this module already had and
  // it is not this issue's to change; what the flag buys is that the probe can say so instead of
  // reporting the same success a signed send reports.
  const secretUnresolved =
    Boolean(a.secretRef) && a.type === "webhook" && !secret;

  const { rawBody, contentType } = buildAlertBody(a);
  const ts = Math.floor(now() / 1000);
  const headers = outboundHeaders({
    contentType,
    deliveryId: a.deliveryId,
    timestampSeconds: ts,
    rawBody,
    secret,
  });
  const signed = Boolean(secret);

  const startedAt = now();
  let status: number;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
  } catch (err) {
    return stopped("request", `request failed: ${alertErrMsg(err, url)}`, {
      signed,
      secretUnresolved,
      durationMs: now() - startedAt,
    });
  }
  const durationMs = now() - startedAt;

  if (status >= 200 && status < 300) {
    return {
      ok: true,
      stoppedAt: null,
      status,
      error: null,
      signed,
      secretUnresolved,
      durationMs,
    };
  }
  return stopped("response", `non-2xx response: ${status}`, {
    status,
    signed,
    secretUnresolved,
    durationMs,
  });
}
