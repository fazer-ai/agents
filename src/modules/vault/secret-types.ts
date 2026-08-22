// Predefined secret types (item 8). A vault entry can carry a `kind` from this catalog; the kind
// declares HOW the secret is injected into an outbound request so the operator no longer hand-writes
// the header (e.g. the Chatwoot `api-access-token` header, or `Authorization: Bearer …`). The catalog
// is CODE-FIRST (no DB enum): adding a type is one entry here. `generic` (or a null/unknown kind) is
// the legacy escape hatch — no auto-injection, the operator wires it manually via the `{{secret}}`
// header placeholder. Labels are i18n keys on the client (`vault.secretType.<id>`), so this file
// stays language-neutral.

import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";

export type SecretInjection = "none" | "header" | "bearer" | "basic" | "query";

// Declarative connectivity test for a credential type (n8n parity: each type carries its own test).
// The runner (secret-test.ts) builds a GET to `base + path`, applying the SAME injection the real
// requests use (resolveSecretInjection), so the test exercises the actual auth path. Only service
// types (a fixed, known API) carry a test; generic mechanisms have no endpoint to probe.
export interface SecretTestSpec {
  // Fixed bases to try in order. The first 2xx wins; on an auth/transport failure the runner falls
  // through to the next (used by asaas: production then sandbox). Mutually exclusive with needsBase.
  bases?: string[];
  // When true the operator-supplied baseURL is the (only) base — for self-hosted/configurable APIs
  // (chatwoot, openai-compatible). The runner SSRF-guards it. No baseURL → result `missing_base_url`.
  needsBase?: boolean;
  path: string;
  // Extra static headers the probe endpoint requires beyond the injected credential (e.g. the
  // anthropic-version header). Never carries the secret.
  extraHeaders?: Record<string, string>;
  // Scope-aware pass: some providers gate each endpoint behind a per-resource permission, so a
  // VALID-but-scoped key gets a 4xx whose body still proves the credential authenticated (e.g.
  // ElevenLabs "missing_permissions": the key is real, it just lacks the probe endpoint's scope).
  // When set, the runner reads the 4xx body and, if this predicate matches, treats the probe as a
  // pass — the test only needs to confirm the credential is real, not that it can read this exact
  // resource. Receives the status + (capped) body text; the body is matched, never logged.
  authConfirmedOn4xx?: (status: number, bodyText: string) => boolean;
}

export interface SecretType {
  id: string;
  injection: SecretInjection;
  // For injection "header"/"query" on service-specific types: the fixed header/query-param name.
  // For generic mechanism types (needsParamName=true), the name comes from VaultEntry.paramName
  // (operator-supplied) instead; this field is absent.
  name?: string;
  // When true, the param name is operator-supplied (VaultEntry.paramName) rather than fixed in the
  // catalog. The service layer enforces that paramName is non-empty for these kinds.
  needsParamName?: boolean;
  // For types whose VALUE is a multi-field object (not a plain string), declares the fields.
  // The generic credential form renders each field as a separate input; masked=true → password input.
  // When absent, the value is expected to be a plain non-empty string.
  fields?: { key: string; masked?: boolean }[];
  // The VALUE must NEVER travel in an outbound HTTP request: it is consumed somewhere else entirely
  // (mcp_env by the stdio loader, langfuse by observability). `injection: "none"` alone does NOT
  // mean this — `generic` carries it too, and there it means the opposite: no rule, so a caller may
  // apply its own default.
  neverOutbound?: boolean;
  // Logical service identity (drives the credential logo + the per-context "compatible types"
  // filter on the client). Absent for generic mechanisms.
  service?: string;
  // Optional connectivity test (test-on-save). Absent ⇒ the type is not testable.
  test?: SecretTestSpec;
  // When true, a non-empty baseUrl is required to create or update this credential kind.
  requiresBaseUrl?: boolean;
  // When true, the VALUE is a server-managed JSON blob (created empty, populated by a connect flow
  // like OAuth DCR + consent). Exempt from validateVaultValue's field/string shape check — only
  // "must be an object" is enforced. The operator never types the secret value directly.
  managedBlob?: boolean;
}

// Order is the UI display order. Keep `generic` first (the default); generic mechanisms, then the
// service-specific types (which carry a logo + a connectivity test).
export const SECRET_TYPES: SecretType[] = [
  { id: "generic", injection: "none" },
  { id: "bearer_token", injection: "bearer" },
  // Generic header injection — the operator names the header in VaultEntry.paramName.
  { id: "header", injection: "header", needsParamName: true },
  { id: "basic_auth", injection: "basic" },
  // Generic query injection — the operator names the query parameter in VaultEntry.paramName.
  { id: "query", injection: "query", needsParamName: true },
  {
    id: "openai",
    injection: "bearer",
    service: "openai",
    test: { bases: ["https://api.openai.com"], path: "/v1/models" },
  },
  {
    id: "anthropic",
    injection: "header",
    name: "x-api-key",
    service: "anthropic",
    test: {
      bases: ["https://api.anthropic.com"],
      path: "/v1/models",
      extraHeaders: { "anthropic-version": "2023-06-01" },
    },
  },
  {
    id: "gemini",
    injection: "header",
    name: "x-goog-api-key",
    service: "gemini",
    test: {
      bases: ["https://generativelanguage.googleapis.com"],
      path: "/v1beta/models",
    },
  },
  {
    id: "deepseek",
    injection: "bearer",
    service: "deepseek",
    test: { bases: ["https://api.deepseek.com"], path: "/models" },
  },
  {
    id: "openrouter",
    injection: "bearer",
    service: "openrouter",
    test: { bases: ["https://openrouter.ai/api/v1"], path: "/models" },
  },
  {
    id: "openai_compatible",
    injection: "bearer",
    service: "openai_compatible",
    requiresBaseUrl: true,
    // Base is the operator's API root (typically ending in /v1); the probe hits {base}/models.
    test: { needsBase: true, path: "/models" },
  },
  {
    id: "elevenlabs",
    injection: "header",
    name: "xi-api-key",
    service: "elevenlabs",
    // /v1/user needs the `user_read` scope; a key restricted to TTS/STT 401s with
    // detail.status="missing_permissions" — valid key, wrong scope. No ElevenLabs endpoint is
    // scope-free, so we accept that body as a pass and only fail on a genuine auth error
    // (invalid_api_key / needs_authorization).
    test: {
      bases: ["https://api.elevenlabs.io"],
      path: "/v1/user",
      authConfirmedOn4xx: (status, body) =>
        status === 401 && body.includes('"missing_permissions"'),
    },
  },
  {
    id: "asaas",
    injection: "header",
    name: "access_token",
    service: "asaas",
    // The vault credential is environment-agnostic; try production then sandbox (the key is valid
    // for exactly one, so whichever 2xx-es identifies it).
    test: {
      bases: ["https://api.asaas.com/v3", "https://api-sandbox.asaas.com/v3"],
      path: "/myAccount",
    },
  },
  {
    id: "chatwoot_api_token",
    injection: "header",
    // Reused from the Chatwoot client so an agent's HTTP tool / the connectivity test authenticate
    // with the SAME header; hyphenated to survive proxies that drop underscores (chatwoot/constants.ts).
    name: CHATWOOT_AUTH_HEADER,
    service: "chatwoot",
    requiresBaseUrl: true,
    // Self-hosted: the operator's Chatwoot base. Probes the user-scoped profile endpoint.
    test: { needsBase: true, path: "/api/v1/profile" },
  },
  // Google OAuth 2.1 (Authorization Code + PKCE). The VALUE the operator supplies is the OAuth app
  // pair { clientId, clientSecret }; the consent flow (oauth-google.controller.ts) then MERGES the
  // tokens (accessToken/refreshToken/expiresAt/scopes/email) into the same blob via a path that does
  // NOT go through validateVaultValue. At consumption the runtime calls ensureFreshGoogleAccessToken
  // and injects the fresh access token as a bearer header. Multi-field ⇒ not testable.
  {
    id: "google_oauth",
    injection: "bearer",
    service: "google",
    fields: [{ key: "clientId" }, { key: "clientSecret", masked: true }],
  },
  // Generic OAuth 2.1 for external MCP servers (discovery RFC 8414/9728 + DCR RFC 7591 + PKCE +
  // refresh-token rotation). The operator supplies ONLY the MCP server URL (baseUrl); the client_id
  // is obtained via Dynamic Client Registration at Connect time and the tokens are merged by the
  // consent flow (oauth-mcp.controller.ts). The VALUE is a server-managed JSON blob created empty
  // (managedBlob ⇒ no `fields`, exempt from validateVaultValue). At consumption the runtime calls
  // ensureFreshMcpAccessToken and injects the fresh access token as a bearer header.
  {
    id: "mcp_oauth",
    injection: "bearer",
    service: "mcp",
    requiresBaseUrl: true,
    managedBlob: true,
  },
  // Environment variable for a stdio MCP server (many stdio servers read their token from an env var,
  // e.g. API_TOKEN, rather than an HTTP header). The VALUE is the plain secret string; the env var
  // NAME is operator-supplied in VaultEntry.paramName (needsParamName). injection "none": NEVER injected
  // into an outbound HTTP request — the stdio loader (buildConnConfig) reads paramName+secret and
  // spawns the process with `env: { [paramName]: secret }`. No baseUrl, no connectivity test.
  {
    id: "mcp_env",
    injection: "none",
    neverOutbound: true,
    service: "mcp",
    needsParamName: true,
  },
  // Langfuse tracing keys. The VALUE is a JSON pair { publicKey, secretKey } (not a single string),
  // consumed directly by observability — never injected into an outbound request, hence "none".
  // Created/updated via the generic credential form (baseUrl holds the Langfuse host URL).
  {
    id: "langfuse",
    injection: "none",
    neverOutbound: true,
    service: "langfuse",
    requiresBaseUrl: true,
    fields: [{ key: "publicKey" }, { key: "secretKey", masked: true }],
  },
];

const BY_ID = new Map(SECRET_TYPES.map((s) => [s.id, s]));

export const SECRET_TYPE_IDS = SECRET_TYPES.map((s) => s.id);

export function isSecretTypeId(id: string): boolean {
  return BY_ID.has(id);
}

export function isTestableSecretType(id: string | null | undefined): boolean {
  return !!getSecretType(id)?.test;
}

export function getSecretType(
  id: string | null | undefined,
): SecretType | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

export function secretTypeNeedsParamName(
  id: string | null | undefined,
): boolean {
  return !!getSecretType(id)?.needsParamName;
}

export function secretTypeRequiresBaseUrl(
  id: string | null | undefined,
): boolean {
  return !!getSecretType(id)?.requiresBaseUrl;
}

// True for kinds whose VALUE is a server-managed JSON blob (created empty; see SecretType.managedBlob).
// Used by validateVaultValue to skip the field/string shape check for these kinds.
export function secretTypeIsManagedBlob(
  id: string | null | undefined,
): boolean {
  return !!getSecretType(id)?.managedBlob;
}

// OAuth credential kinds whose stored secret is a JSON object (not a plain string) carrying tokens
// that the runtime auto-refreshes before injecting as a bearer header — google_oauth and mcp_oauth.
// Callers in the tool-assembly + MCP-load path use this to (a) NOT read a string secret at load time
// and (b) resolve a fresh access token (refreshCredential) before connecting.
const MANAGED_OAUTH_KINDS = new Set<string>(["google_oauth", "mcp_oauth"]);

export function isManagedOAuthKind(kind: string | null | undefined): boolean {
  return kind != null && MANAGED_OAUTH_KINDS.has(kind);
}

export function getSecretTypeFields(
  id: string | null | undefined,
): { key: string; masked?: boolean }[] | null {
  return getSecretType(id)?.fields ?? null;
}

// Concrete request mutation for a credential's kind + resolved secret. Returns null when the kind has
// no auto-injection (generic / unknown / empty secret) — the caller then falls back to the manual
// `{{secret}}` header placeholder. Header injections (header/bearer/basic) add a header; `query` adds
// a URL query parameter.
//
// For injection "header"/"query" on types with needsParamName=true, `paramName` (from the stored
// VaultEntry) is used as the effective name. When paramName is absent/empty for these types, returns
// null (auto-injection disabled — the operator has not configured a param name).
export type ResolvedInjection =
  | { target: "header"; name: string; value: string }
  | { target: "query"; name: string; value: string };

// A kind that must NEVER travel in an outbound HTTP request. `resolveSecretInjection` returns null
// for these AND for a kind with no injection rule at all, and a caller that falls back to a Bearer
// on null would send exactly these secrets to somebody else's endpoint. The two nulls mean opposite
// things: no rule is "use your default", never-outbound is "there is a rule and it says no". The
// catalogue says which, because deriving it from `injection: "none"` swept in `generic`, whose whole
// purpose IS that default — and reading the two as one silenced every contact of an operator using
// a generic credential.
export function isNonInjectableSecret(
  kind: string | null | undefined,
): boolean {
  return getSecretType(kind)?.neverOutbound === true;
}

export function resolveSecretInjection(
  kind: string | null | undefined,
  secret: string,
  paramName?: string | null,
): ResolvedInjection | null {
  if (!secret) return null;
  const type = getSecretType(kind);
  if (!type) return null;
  switch (type.injection) {
    case "bearer":
      return {
        target: "header",
        name: "Authorization",
        value: `Bearer ${secret}`,
      };
    case "basic":
      return {
        target: "header",
        name: "Authorization",
        value: `Basic ${secret}`,
      };
    case "header": {
      const effectiveName = type.name ?? paramName;
      return effectiveName
        ? { target: "header", name: effectiveName, value: secret }
        : null;
    }
    case "query": {
      const effectiveName = type.name ?? paramName;
      return effectiveName
        ? { target: "query", name: effectiveName, value: secret }
        : null;
    }
    default:
      return null;
  }
}
