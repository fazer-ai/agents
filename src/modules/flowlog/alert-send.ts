import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import { sanitizeErrorMessage } from "@/lib/redact";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { redactEndpoint } from "@/modules/audit/projection";
import { consoleUrl } from "@/modules/mcp/console-links";
import { resolveSigningSecret } from "@/modules/vault/service";
import { outboundHeaders } from "@/modules/webhooks/outbound/signing";

// The one place an alert becomes an HTTP request. The worker and the console's Test button both
// call it, so a green test is evidence about the path a real alert takes; they differ only in what
// they do with the answer (move a delivery row, or show the outcome to a person).

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_LEN = 500;

// A channel URL is a secret (a Discord webhook embeds a bot token), and some fetch errors (Bun's
// `UnexpectedRedirect`) quote it in full. The known destination is masked first by literal match,
// because a regex cannot be trusted to find where a URL ends; this regex is the backstop for URLs
// the caller does not know, such as a redirect target. Every match collapses to `scheme://host/…`,
// so over-matching is harmless, and the required scheme leaves a bare host in a DNS error readable.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;

function maskUrlsIn(text: string, known?: string): string {
  const withoutKnown =
    known && known.length > 0
      ? text.split(known).join(redactEndpoint(known))
      : text;
  return withoutKnown.replace(URL_IN_TEXT, (u) => redactEndpoint(u));
}

// `sanitizeErrorMessage` rather than a bare cut: this string is stored in `last_error` and wraps
// what the remote endpoint answered, and a NUL or an orphan surrogate costs the whole write (see
// that function's header). The masking runs FIRST, so the 500-character cut cannot leave half a
// token.
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
  // Where the first event of the window happened. The tenant is what the links carry so the console
  // opens on it; the two ids are null on a probe and on a row written before the columns existed,
  // and then the body carries no link.
  tenantId: bigint | null;
  turnId: string | null;
  conversationId: bigint | null;
  // Set on a cause alert: its burst gathers every line of the cause, whatever level each was
  // written at, so the list it links to is not narrowed by level.
  causeKey: string | null;
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
  // Set when the channel names a signing secret that did not resolve, so this went out unsigned:
  // the sentence to show the operator and to store on the row. A sentence rather than a flag,
  // because the unsigned causes (none configured, credential deleted, never filled) are one wire
  // request and three different fixes.
  unsignedReason: string | null;
  // Wall time of the request itself, null when none was made.
  durationMs: number | null;
}

type AlertBodyInput = Pick<
  AlertSendTarget,
  | "type"
  | "stage"
  | "level"
  | "summary"
  | "count"
  | "tenantId"
  | "turnId"
  | "conversationId"
  | "causeKey"
>;

// Where the operator goes from the alert. The ids name the FIRST event of the window, and a burst's
// members can be unrelated conversations, so a burst links to the stage+level list and a single
// event links to its own turn (plus its conversation when the mirror knew one). No `source`: only
// inbox traffic alerts, which is the page's default. `consoleUrl` names the tenant so an operator
// of several tenants lands on the right one. Each link carries the label the body prints for it, so
// the burst's says how many lines the list holds.
export function alertLinks(
  a: AlertBodyInput,
): { label: string; url: string }[] {
  const opts = { tenantId: a.tenantId };
  if (a.count > 1) {
    const q = new URLSearchParams();
    if (a.stage) q.set("stage", a.stage);
    if (a.causeKey === null) q.set("level", a.level);
    return [
      { label: `View all ${a.count}`, url: consoleUrl(`/logs?${q}`, opts) },
    ];
  }
  if (!a.turnId) return [];
  const q = new URLSearchParams({ turnId: a.turnId });
  const links = [{ label: "View log", url: consoleUrl(`/logs?${q}`, opts) }];
  if (a.conversationId != null) {
    links.push({
      label: "View conversation",
      url: consoleUrl(`/conversations/${a.conversationId}`, opts),
    });
  }
  return links;
}

const DISCORD_MAX = 1900;

// Discord-native markdown (its webhook expects `{ content }`); the generic webhook gets a versioned
// JSON envelope. Both carry the coalesced burst count, never message text/PII.
export function buildAlertBody(a: AlertBodyInput): {
  rawBody: string;
  contentType: string;
} {
  const times = a.count > 1 ? ` (×${a.count})` : "";
  if (a.type === "discord") {
    const icon = a.level === "error" ? "🔴" : "🟠";
    const head = `${icon} **fazer.ai agents** \`${a.stage ?? "—"}\` ${a.level}${times}\n${a.summary}`;
    // Masked links, so the line reads as two words instead of two 80-character URLs, with the URL
    // still in angle brackets so Discord does not unfurl the console's login page under every
    // alert. Appended AFTER the clip, which takes its room out of the summary: the link is the part
    // an operator acts on, and a long summary must not cut it in half.
    const links = alertLinks(a)
      .map((l) => `[${l.label}](<${l.url}>)`)
      .join(" · ");
    const content = links
      ? `${clipText(head, DISCORD_MAX - links.length - 1)}\n${links}`
      : clipText(head, DISCORD_MAX);
    return {
      rawBody: JSON.stringify({ content }),
      contentType: "application/json",
    };
  }
  // Ids rather than rendered URLs, since this consumer is code; null when there is no event.
  return {
    rawBody: JSON.stringify({
      version: 1,
      type: "alert",
      stage: a.stage,
      level: a.level,
      count: a.count,
      summary: a.summary,
      turnId: a.turnId,
      conversationId:
        a.conversationId == null ? null : String(a.conversationId),
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
    unsignedReason: null,
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

  // Optional HMAC secret (generic webhook), resolved through a tenant-scoped read. A ref that
  // names nothing (deleted, or created and never filled) yields no secret and the send goes out
  // UNSIGNED rather than holding the alert back; `unsignedReason` carries which case it was.
  let secret: string | null = null;
  let unsignedReason: string | null = null;
  if (a.type === "webhook") {
    try {
      const ref = a.secretRef;
      const resolved = await runScopedOn(base, ctx, (db) =>
        resolveSigningSecret(db, ref),
      );
      secret = resolved.secret;
      unsignedReason = resolved.unsignedReason;
    } catch (err) {
      return stopped(
        "secret",
        `secret resolution failed: ${alertErrMsg(err, url)}`,
      );
    }
  }

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
      unsignedReason,
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
      unsignedReason,
      durationMs,
    };
  }
  return stopped("response", `non-2xx response: ${status}`, {
    status,
    signed,
    unsignedReason,
    durationMs,
  });
}
