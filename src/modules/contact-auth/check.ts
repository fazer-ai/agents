import config from "@/config";
import { assertSafeOutboundUrl, SsrfError } from "@/lib/ssrf";
import type { InjectableCredential } from "@/modules/vault/injectable";
import { resolveSecretInjection } from "@/modules/vault/secret-types";
import type { ContactAuthConfig } from "./settings";

// One authorization request and the reading of its answer. The contract is deliberately small
// (docs/contact-auth.md): one POST, carrying the mirrored identity under `contact`, the conversation
// coordinates under `conversation` and, only when the agent opted in, the customer's text under
// `message`. A 2xx must answer `{ "authorized": boolean }`; 401/403/404 mean denied; and anything
// else (another status, a timeout, a network failure, a blocked URL, an answer that does not fit) is
// an ERROR, which the gate treats as fail-closed. `classifyAuthorizationResponse` is the pure half
// so the decision table is testable without a socket; `checkContactAuthorization` is the network
// half, with fetch and the SSRF assertion injectable.

export type AuthorizationOutcome = "allowed" | "denied" | "error";

// The gate's fourth answer, which no endpoint gives: the contact cannot be asked about because the
// mirror holds nothing that identifies them to the operator's system (no phone, no email, no
// operator identifier). Named apart from a denial, treated like one: fail-closed means nobody
// unidentified is served.
export type ContactAuthOutcome = AuthorizationOutcome | "no_identity";

export interface AuthorizationVerdict {
  outcome: AuthorizationOutcome;
  // HTTP status of the answer, when one arrived.
  status?: number;
  // OUR failure code, from the fixed list below. Safe to log because we wrote every possible value.
  reason?: string;
  // What the ENDPOINT called it. Kept apart from `reason` and kept OUT of telemetry: the slug guard
  // checks the SHAPE of this value, and `5511999999999` and `customer_4821` are both slug-shaped.
  // A phone number is not less of a phone number for looking like a code, and the execution log is
  // read by alert channels that promise PII-free detail. It still reaches the operator note, which
  // sits in their own Chatwoot next to the conversation it is about.
  endpointReason?: string;
}

// A verdict as the gate consumes it: the outcome widened with the runtime's own fourth answer.
export interface ContactAuthVerdict {
  outcome: ContactAuthOutcome;
  status?: number;
  reason?: string;
  endpointReason?: string;
}

// The identity the request carries. ALWAYS from trusted context (the mirrored Chatwoot contact),
// never from anything the model wrote. `messageText` is the one deliberate exception, and it
// travels apart: what the customer typed goes under `message`, never inside `contact`, so the
// endpoint can give each the trust it deserves.
export interface ContactIdentity {
  phone: string | null;
  name: string | null;
  email: string | null;
  // The operator's own id for this customer (the Chatwoot contact `identifier`, mirrored into
  // Contact.attributes). The strongest key an endpoint can receive: it minted this id itself.
  identifier: string | null;
  // The Chatwoot contact id (null on a mirror row that never learned it). Context, NOT identity:
  // it names the row to Chatwoot and says nothing to the operator's system.
  chatwootContactId: number | null;
  conversationId: number;
  inboxId: number | null;
  // The inbox's channel as a slug ("whatsapp", "web_widget", ...); null when unknown.
  channel: string | null;
  // The text of the message that triggered the check; null on a proactive nudge. Sent as
  // `message.text` when includeMessageText is on, capped at MESSAGE_TEXT_MAX chars.
  messageText: string | null;
}

export interface CheckDeps {
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<URL>;
  // A deadline already running when this is called, and everything it covers already counted
  // against `timeoutMs`. The orchestration passes one because the credential is resolved BEFORE the
  // request, and a managed-OAuth entry refreshes its token there under a ceiling of its own: timed
  // from here, a gate set to one second could hold the webhook for eleven. When absent, the check
  // arms its own — the shape every test and every direct caller uses.
  signal?: AbortSignal;
}

// What an endpoint may say in `reason` and have it kept: a code, not a sentence.
export const REASON_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Bound on the answer read before parsing. A verdict is a few bytes; a body past this is not one.
export const MAX_RESPONSE_BYTES = 64 * 1024;
// Cap on the forwarded customer text: an unlock code is short, and the endpoint's job here is a
// verdict, not an archive of the conversation. Excess is cut, not refused.
export const MESSAGE_TEXT_MAX = 4000;

export function reasonSlug(v: unknown): string | undefined {
  return typeof v === "string" && REASON_SLUG_RE.test(v) ? v : undefined;
}

// "Channel::WebWidget" (the mirror's raw channel_type) as the slug the endpoint sees ("web_widget").
export function channelSlug(channelType: string | null): string | null {
  if (!channelType) return null;
  const slug = channelType
    .replace(/^Channel::/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .trim();
  return slug || null;
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// The decision table. `body` is null when the answer was too large to read.
// The statuses that deny on their own. An endpoint may answer REST-style with no body at all, so
// what they say is settled before the body is read — and stays settled when it cannot be.
function deniesOnStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export function classifyAuthorizationResponse(
  status: number,
  body: string | null,
): AuthorizationVerdict {
  const json = body === null ? null : parseJsonObject(body);
  // FIRST, because these three say everything they need to say in the status line: an endpoint may
  // answer REST-style with no body at all, so a body we could not read cannot turn the answer into
  // something else. Checked after the body used to mean a 403 behind a proxy with a large error
  // page landed as an ERROR — read as transient, so the customer got no deny message, nobody got
  // the handoff, and every following message asked again about a refusal that was permanent.
  if (deniesOnStatus(status)) {
    const endpointReason = reasonSlug(json?.reason);
    return {
      outcome: "denied",
      status,
      ...(endpointReason ? { endpointReason } : {}),
    };
  }
  // Only a 2xx has to CARRY its verdict, so only a 2xx needs a body we could read.
  if (body === null)
    return { outcome: "error", status, reason: "body_too_large" };
  if (status >= 200 && status < 300) {
    if (!json || typeof json.authorized !== "boolean") {
      return { outcome: "error", status, reason: "invalid_response" };
    }
    const endpointReason = reasonSlug(json.reason);
    return {
      outcome: json.authorized ? "allowed" : "denied",
      status,
      ...(endpointReason ? { endpointReason } : {}),
    };
  }
  return { outcome: "error", status, reason: "unexpected_status" };
}

// The request as sent, built without touching the network so a test can assert on it. The
// credential is injected per its kind (bearer / header / query), by the same resolver HTTP tools and
// MCP connections use; a kind with no catalogued injection (generic) goes out as a Bearer token, as
// it does on an MCP connection, because the operator chose that entry for this endpoint.
export function buildAuthorizationRequest(
  cfg: ContactAuthConfig,
  identity: ContactIdentity,
  credential: InjectableCredential | null,
): { url: URL; init: RequestInit } {
  if (!cfg.url) throw new Error("contact authorization url is not configured");
  const url = new URL(cfg.url);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const text =
    cfg.includeMessageText && identity.messageText?.trim()
      ? identity.messageText.trim().slice(0, MESSAGE_TEXT_MAX)
      : null;
  // NOTE: The nesting IS the contract: `contact` is what Chatwoot mirrored (trusted context),
  // `message` is what the customer typed. An endpoint must never read identity out of `message`.
  const body = JSON.stringify({
    contact: {
      phone: identity.phone,
      name: identity.name,
      email: identity.email,
      identifier: identity.identifier,
      chatwootContactId: identity.chatwootContactId,
    },
    conversation: {
      id: identity.conversationId,
      inboxId: identity.inboxId,
      channel: identity.channel,
    },
    ...(text !== null ? { message: { text } } : {}),
  });
  if (credential) {
    const inj = resolveSecretInjection(
      credential.kind,
      credential.value,
      credential.paramName,
    );
    if (inj?.target === "header") headers[inj.name] = inj.value;
    else if (inj?.target === "query") url.searchParams.set(inj.name, inj.value);
    else headers.authorization = `Bearer ${credential.value}`;
  }
  return { url, init: { method: "POST", headers, body } };
}

// Reads at most `max` bytes; null when the body is larger (declared or streamed). The cap is applied
// BEFORE parsing, so an oversized answer costs neither memory nor a JSON.parse of it.
async function readBodyCapped(
  res: Response,
  max: number,
): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    // Refusing by the header does not excuse leaving the stream open: without this the body (and
    // the socket under it) stays live until the peer gives up, and every check against a chatty
    // endpoint leaks another one. The streamed path below already cancels; this one returned first.
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

// Awaits a promise, but never past the signal. `assertSafeOutboundUrl` resolves DNS and takes no
// AbortSignal, and neither does a managed-OAuth token refresh, so this is what puts them under the
// same deadline as the request they precede. The work itself keeps running when we walk away from
// it — what matters is that the caller does not wait on it.
export function underSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort),
    );
  });
}

// Asks the endpoint once. Never throws: every failure is a verdict with outcome "error" and a reason
// code, because the caller's only correct response to a failure is the same as to a denial without
// the customer message (fail-closed), and a throw here would be a second path to the same place.
export async function checkContactAuthorization(
  cfg: ContactAuthConfig,
  identity: ContactIdentity,
  credential: InjectableCredential | null,
  deps: CheckDeps = {},
): Promise<AuthorizationVerdict> {
  if (!cfg.url) return { outcome: "error", reason: "not_configured" };
  const doFetch = deps.fetchImpl ?? fetch;
  const assertSafe =
    deps.assertSafe ??
    ((u: string) =>
      // NOTE: http only where the SSRF guard already allows private targets, the same tie HTTP
      // tools make (prepare.ts): a local endpoint works in development, production stays https.
      assertSafeOutboundUrl(u, { allowHttp: config.ssrf.allowPrivateTargets }));
  const { url, init } = buildAuthorizationRequest(cfg, identity, credential);
  // NOTE: The deadline is armed BEFORE the URL check, because that check resolves DNS. One
  // unreachable resolver would otherwise hold the pre-turn gate — and the webhook turn behind it —
  // for as long as the resolver takes, with `timeoutMs` only starting to count afterwards. The
  // budget covers every step that waits: the lookup, the fetch, and the body.
  // A deadline handed in is already running and already covers work done before this call; only a
  // check with none of its own arms one here.
  const ctrl = deps.signal ? null : new AbortController();
  const signal = deps.signal ?? (ctrl as AbortController).signal;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), cfg.timeoutMs) : null;
  try {
    try {
      // NOTE: On the FINAL URL, with the identity and any query credential already on it,
      // immediately before the fetch. What is asserted is what is sent.
      await underSignal(assertSafe(url.toString()), signal);
    } catch (err) {
      if (signal.aborted) return { outcome: "error", reason: "timeout" };
      return {
        outcome: "error",
        reason: err instanceof SsrfError ? "unsafe_url" : "invalid_url",
      };
    }
    const res = await doFetch(url.toString(), {
      ...init,
      redirect: "error",
      signal,
    });
    // NOTE: The timer stays armed while the body is read: a server that answers the status line and
    // then stalls would otherwise hold the gate past its timeout.
    let body: string | null;
    try {
      body = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      // A body that stalls or breaks AFTER the status line. On a denying status that changes
      // nothing: those three say everything they need to in the status line, and letting a stalled
      // body turn a permanent refusal into a transient error is the same defect the classifier
      // fixed one layer up (the customer gets no deny message, nobody gets the handoff, and every
      // following message asks again). Any other status has no verdict without its body, so it
      // stays the error the outer catch names — timeout or network, whichever it was.
      if (!deniesOnStatus(res.status)) throw err;
      await res.body?.cancel().catch(() => undefined);
      body = null;
    }
    return classifyAuthorizationResponse(res.status, body);
  } catch (err) {
    const aborted =
      signal.aborted || (err instanceof Error && err.name === "AbortError");
    return { outcome: "error", reason: aborted ? "timeout" : "network" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
