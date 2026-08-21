import config from "@/config";
import { assertSafeOutboundUrl, SsrfError } from "@/lib/ssrf";
import type { InjectableCredential } from "@/modules/vault/injectable";
import { resolveSecretInjection } from "@/modules/vault/secret-types";
import type { ContactAuthConfig } from "./settings";

// One authorization request and the reading of its answer. The contract is deliberately small
// (docs/contact-auth.md): GET carries `phone` and `contact_id` on the query string, POST carries
// them in a JSON body; a 2xx must answer `{ "authorized": boolean }`; 401/403/404 mean denied; and
// anything else (another status, a timeout, a network failure, a blocked URL, an answer that does
// not fit) is an ERROR, which the gate treats as fail-closed. `classifyAuthorizationResponse` is the
// pure half so the decision table is testable without a socket; `checkContactAuthorization` is the
// network half, with fetch and the SSRF assertion injectable.

export type AuthorizationOutcome = "allowed" | "denied" | "error";

// The gate's fourth answer, which no endpoint gives: the contact cannot be asked about because the
// mirror holds no phone for them (a web-widget visitor, a contact created by hand). Named apart from
// a denial, treated like one: fail-closed means nobody unidentified is served.
export type ContactAuthOutcome = AuthorizationOutcome | "no_identity";

export interface AuthorizationVerdict {
  outcome: AuthorizationOutcome;
  // HTTP status of the answer, when one arrived.
  status?: number;
  // A short code naming the reason: the endpoint's own `reason` when it is slug-shaped, else one of
  // the runtime's failure codes below. Never prose, because this value reaches the execution log and
  // the in-memory cache, and the endpoint's free text could quote the customer.
  reason?: string;
}

// The identity the request carries. ALWAYS from trusted context (the mirrored Chatwoot contact),
// never from anything the model or the customer wrote.
export interface ContactIdentity {
  phone: string;
  // The Chatwoot contact id (null on a mirror row that never learned it; then GET omits it).
  contactId: number | null;
  conversationId: number;
  inboxId: number | null;
}

export interface CheckDeps {
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<URL>;
}

// What an endpoint may say in `reason` and have it kept: a code, not a sentence.
export const REASON_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Bound on the answer read before parsing. A verdict is a few bytes; a body past this is not one.
export const MAX_RESPONSE_BYTES = 64 * 1024;

export function reasonSlug(v: unknown): string | undefined {
  return typeof v === "string" && REASON_SLUG_RE.test(v) ? v : undefined;
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
export function classifyAuthorizationResponse(
  status: number,
  body: string | null,
): AuthorizationVerdict {
  if (body === null)
    return { outcome: "error", status, reason: "body_too_large" };
  const json = parseJsonObject(body);
  if (status >= 200 && status < 300) {
    if (!json || typeof json.authorized !== "boolean") {
      return { outcome: "error", status, reason: "invalid_response" };
    }
    const reason = reasonSlug(json.reason);
    return {
      outcome: json.authorized ? "allowed" : "denied",
      status,
      ...(reason ? { reason } : {}),
    };
  }
  if (status === 401 || status === 403 || status === 404) {
    const reason = reasonSlug(json?.reason);
    return { outcome: "denied", status, ...(reason ? { reason } : {}) };
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
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (cfg.method === "POST") {
    headers["content-type"] = "application/json";
    body = JSON.stringify({
      phone: identity.phone,
      contactId: identity.contactId,
      conversationId: identity.conversationId,
      inboxId: identity.inboxId,
    });
  } else {
    url.searchParams.set("phone", identity.phone);
    if (identity.contactId !== null) {
      url.searchParams.set("contact_id", String(identity.contactId));
    }
  }
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
  return { url, init: { method: cfg.method, headers, body } };
}

// Reads at most `max` bytes; null when the body is larger (declared or streamed). The cap is applied
// BEFORE parsing, so an oversized answer costs neither memory nor a JSON.parse of it.
async function readBodyCapped(
  res: Response,
  max: number,
): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
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
  try {
    // NOTE: On the FINAL URL, with the identity and any query credential already on it, immediately
    // before the fetch. What is asserted is what is sent.
    await assertSafe(url.toString());
  } catch (err) {
    return {
      outcome: "error",
      reason: err instanceof SsrfError ? "unsafe_url" : "invalid_url",
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await doFetch(url.toString(), {
      ...init,
      redirect: "error",
      signal: ctrl.signal,
    });
    // NOTE: The timer stays armed while the body is read: a server that answers the status line and
    // then stalls would otherwise hold the gate past its timeout.
    const body = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    return classifyAuthorizationResponse(res.status, body);
  } catch (err) {
    const aborted =
      ctrl.signal.aborted ||
      (err instanceof Error && err.name === "AbortError");
    return { outcome: "error", reason: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
