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
  // Whether this kind carries a persistent base URL (VaultEntry.baseUrl), and whether it can be
  // created without one. ONE declaration rather than a supports/requires pair, because "required
  // but not supported" is not a state any kind can be in and a pair lets it be written: the
  // console's own mirror kept the two as separate booleans and the server declared only half of
  // them, which is how every kind ended up storing a base URL nine of them never show (#504).
  // Absent ⇒ the kind has no use for one, and a non-empty baseUrl on it is REFUSED at the write
  // boundary — the field is read straight off the entry by the model, vision, STT, TTS and MCP
  // paths (`credentialBaseUrl ?? cfg.baseURL`), so a value stored on a kind whose form never shows
  // it silently redirects where the credential is sent.
  baseUrl?: "required" | "optional";
  // When true, the VALUE is a server-managed JSON blob (created empty, populated by a connect flow
  // like OAuth DCR + consent). Exempt from validateVaultValue's field/string shape check — only
  // "must be an object" is enforced. The operator never types the secret value directly.
  managedBlob?: boolean;
}

// Order is the UI display order. Keep `generic` first (the default); generic mechanisms, then the
// service-specific types (which carry a logo + a connectivity test).
export const SECRET_TYPES: SecretType[] = [
  { id: "generic", injection: "none", baseUrl: "optional" },
  { id: "bearer_token", injection: "bearer", baseUrl: "optional" },
  // Generic header injection — the operator names the header in VaultEntry.paramName.
  {
    id: "header",
    injection: "header",
    needsParamName: true,
    baseUrl: "optional",
  },
  { id: "basic_auth", injection: "basic", baseUrl: "optional" },
  // Generic query injection — the operator names the query parameter in VaultEntry.paramName.
  {
    id: "query",
    injection: "query",
    needsParamName: true,
    baseUrl: "optional",
  },
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
    baseUrl: "required",
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
    baseUrl: "required",
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
    baseUrl: "required",
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
    baseUrl: "required",
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

// The kinds that read `paramName`, in catalog order. Both halves of the applicability rule are
// derived from the same declaration, so a kind added to `SECRET_TYPES` lands on whichever side its
// own entry puts it, and the refusal below can NAME the alternatives instead of only saying no.
export const PARAM_NAME_KIND_IDS: string[] = SECRET_TYPES.filter(
  (s) => s.needsParamName,
).map((s) => s.id);

// Whether a non-empty `paramName` on this kind must be REFUSED at the write boundary. Not the
// negation of `secretTypeNeedsParamName`, and the difference is the whole reason this is a function:
// that one answers false for a kind the catalog does not know, and refusing those would strand every
// row an older build wrote with a kind this one has since dropped — the same carve-out
// `secretTypeFits` makes, for the same reason.
//
// The field is only ever read through `resolveSecretInjection`, which takes the name from a
// `needsParamName` entry and from nowhere else. Storing it on any other kind is storing something
// the runtime discards: the write answered 200, the console read the name back, and the outbound
// request carried no credential at all (issue #488).
export function secretTypeRefusesParamName(
  id: string | null | undefined,
): boolean {
  const type = getSecretType(id);
  return type != null && !type.needsParamName;
}

// Whether the kind puts the credential on the outbound request BY ITSELF. False for `generic` — the
// escape hatch whose whole contract is that the operator writes `{{secret}}` where the API wants it —
// and for a kind this build does not know, which is treated as `generic` everywhere else.
export function secretTypeAutoInjects(id: string | null | undefined): boolean {
  const type = getSecretType(id);
  return type != null && type.injection !== "none";
}

// The kinds that inject a credential without naming a service: bearer/header/basic/query. Derived
// rather than listed, and the two conditions are both load-bearing — a kind that injects but names a
// service (`openai`, `asaas`, …) is not an alternative for an arbitrary HTTP tool, it is a different
// API. This is what the unused-credential warning offers instead of only saying the credential is dead.
export const INJECTING_MECHANISM_KIND_IDS: string[] = SECRET_TYPES.filter(
  (s) => s.injection !== "none" && !s.service,
).map((s) => s.id);

export function secretTypeRequiresBaseUrl(
  id: string | null | undefined,
): boolean {
  return getSecretType(id)?.baseUrl === "required";
}

// Whether the kind has any use for a base URL at all. Required implies supported by construction —
// that is the whole reason the catalog declares one field and not two.
export function secretTypeSupportsBaseUrl(
  id: string | null | undefined,
): boolean {
  return getSecretType(id)?.baseUrl != null;
}

// The kinds that carry a base URL, in catalog order — the same shape `PARAM_NAME_KIND_IDS` has, and
// for the same reason: the refusal below can NAME the alternatives instead of only saying no.
export const BASE_URL_KIND_IDS: string[] = SECRET_TYPES.filter(
  (s) => s.baseUrl != null,
).map((s) => s.id);

// Whether a non-empty `baseUrl` on this kind must be REFUSED at the write boundary. Not the negation
// of `secretTypeSupportsBaseUrl`, and the difference is the same carve-out `secretTypeRefusesParamName`
// makes: a kind this build does not know answers false, so an entry written by a build whose catalog
// had a kind this one dropped stays editable.
//
// The field is read straight off the resolved entry by the model path (`credentialBaseUrl ?? mc.baseURL`
// in prepare.ts), vision, STT, TTS, the HTTP-tool base and the MCP connection URL — none of them
// asking the kind. So a base URL stored on a kind whose console form never renders the input is a
// redirect nobody can see: the operator's provider key goes to that host on the next turn, and the
// only surface that already asks the question is the embedding path, which honours the entry's
// baseUrl for `openai_compatible` and nothing else (rag/documents.ts, and it says why).
export function secretTypeRefusesBaseUrl(
  id: string | null | undefined,
): boolean {
  const type = getSecretType(id);
  return type != null && type.baseUrl == null;
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

// What a field that names a credential DOES with it, and therefore what it needs the entry to be
// able to give. The catalog knows the shapes; only the reading field knows which one it can use, and
// until this existed nobody asked: every write boundary stopped at "does this ref resolve".
//
//   apiKey       The stored value IS the credential the request carries — an API key handed to a
//                provider SDK (the agent's model and its four model overrides, STT, TTS, vision) or
//                to a REST client. It needs the plain string itself.
//   injectable   The value is resolved through `resolveInjectableCredentialEntry`, which hands back
//                a FRESH access token for the managed-OAuth kinds and the stored string for the
//                rest. It can therefore use a JSON blob it never sees (HTTP tools, MCP connections,
//                the contact authorization gate).
//   embeddingKey The tenant's embedding key, and the one field whose reader takes a SECOND value
//                form the catalog does not declare: `resolveEmbeddingStatus` accepts the plain
//                string or `{ apiKey, baseURL }`, destructuring the object and using its `baseURL`
//                as the last fallback. Same KIND rule as `apiKey` — a `google_oauth` or `mcp_env`
//                entry is refused there exactly the same way — and exempt from the VALUE rule,
//                because enforcing "a generic kind holds a string" would refuse a form that reader
//                has always supported. The debt is the undeclared form, not this exemption:
//                declaring it in the catalog is what would remove the third value, and that is a
//                change to how embedding credentials are stored, not to this one.
//
// Both send the result to somebody else's endpoint, which is why `neverOutbound` fails for both:
// mcp_env holds a perfectly good string that the stdio loader reads, and putting it in an API-key
// field mails the operator's stdio token to a model vendor.
export type CredentialUse = "apiKey" | "injectable" | "embeddingKey";

// Whether an entry of this KIND can supply what a field of this USE reads. The one question the
// three surfaces ask — the write boundary refusing a pairing, config-health reporting a stored one,
// the runtime declining to use it — so that they cannot answer it differently. Issue #471.
//
// A kind this build does not know (and a null kind, which is every entry created before the catalog)
// is the legacy `generic` escape hatch: a plain string with no injection rule. Refusing those would
// invalidate working installs over a catalog entry we removed.
export function secretTypeFits(
  kind: string | null | undefined,
  use: CredentialUse,
): boolean {
  const type = getSecretType(kind);
  if (!type) return true;
  if (type.neverOutbound) return false;
  if (use === "injectable") {
    // Mirrors resolveInjectableCredentialEntry: managed OAuth resolves to a token, everything else
    // has to already be the string.
    return isManagedOAuthKind(type.id) || yieldsPlainString(type);
  }
  // `apiKey` and `embeddingKey` are the same question about the KIND; they differ only in whether
  // the stored VALUE is also held to it (see `valueRuleApplies`).
  return yieldsPlainString(type);
}

// Whether this use reads a PLAIN KEY out of the entry, as opposed to resolving it through the
// injectable path. Two of the three do, and the difference matters twice: it is the kind rule below,
// and it is which of the two refusal sentences the write boundary throws. Those two were derived
// separately once — `use === "apiKey"` — and the day a third use appeared it silently told an
// operator that their `google_oauth` embedding key "is never sent outbound", which is false about
// that kind and about that field.
export function readsPlainKey(use: CredentialUse): boolean {
  return use !== "injectable";
}

// Whether a field of this use holds its credential's stored VALUE to the kind's declared shape, as
// opposed to only holding its KIND to the field's needs. Exactly one use says no, and the comment on
// `CredentialUse` says why.
export function valueRuleApplies(use: CredentialUse): boolean {
  return use !== "embeddingKey";
}

// CAN THIS ENTRY SERVE THIS FIELD — the whole question, in one place, because it is the question the
// write boundary, the import warning and config-health all ask and the defect this change exists to
// fix was those three answering it differently. Three call sites spelling out `secretTypeFits(...) &&
// (!valueRuleApplies(...) || ...)` is three chances to drift, and it drifted twice inside one review
// round: config-health applied the value rule to a use that is exempt from it, and the import did the
// same in a place no test could reach yet.
//
// `facts` is what the vault answers about one entry beyond its existence — read through
// `readVaultRefFacts`, or off `listVaultInfos` for the console — never the secret itself.
export function credentialServes(
  facts: { kind: string | null; valueFitsKind: boolean },
  use: CredentialUse,
): boolean {
  return (
    secretTypeFits(facts.kind, use) &&
    (!valueRuleApplies(use) || facts.valueFitsKind)
  );
}

// Whether the stored VALUE is the shape its own KIND declares. The predicate above reads the catalog;
// this one reads what is actually in the row, and the two can disagree — an entry created before its
// kind existed, or one written by a path that does not go through `validateVaultValue`.
//
// Deliberately asymmetric, and the asymmetry is the whole content. A string-valued kind is checked
// strictly, because that is the case a reader breaks on. A multi-field or managed-blob kind is only
// checked for being an object, NOT for its declared field list: the OAuth consent flows MERGE tokens
// into `google_oauth` and `mcp_oauth` values outside `validateVaultValue` (the catalog says so at both
// entries), so demanding exactly `{ clientId, clientSecret }` would report every CONNECTED Google
// account as malformed.
export function secretValueFitsKind(
  kind: string | null | undefined,
  value: unknown,
): boolean {
  const type = getSecretType(kind);
  if (type && !yieldsPlainString(type)) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === "string" && value.length > 0;
}

// The two declarations that say the stored VALUE is not a string: a declared field list (the value
// is a multi-field object) and a server-managed blob. Kept as one predicate so a third declaration
// of the same idea has one place to be added.
function yieldsPlainString(type: SecretType): boolean {
  return !type.fields && !type.managedBlob;
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
