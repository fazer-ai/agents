// Client-side mirror of the predefined secret-type ids (item 8). The source of truth for behavior
// (how each type injects the credential + its connectivity test) is the server catalog in
// `src/modules/vault/secret-types.ts`; the client mirrors only what the UI needs: the id list (type
// picker), the logical service (logo + the per-context "compatible types" filter), and whether the
// type is testable / needs a base URL (test-on-save). Labels come from i18n (`vault.secretType.<id>`).
// Keep this list in sync when adding a type on the server.
export const SECRET_TYPE_IDS = [
  "generic",
  "bearer_token",
  "header",
  "basic_auth",
  "query",
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "openrouter",
  "openai_compatible",
  "elevenlabs",
  "asaas",
  "chatwoot_api_token",
  "langfuse",
  "google_oauth",
  "mcp_oauth",
  "mcp_env",
] as const;

export type SecretTypeId = (typeof SECRET_TYPE_IDS)[number];

export interface SecretTypeMeta {
  // Logical service identity (drives the credential logo + the compatible-types filter). Absent for
  // generic mechanisms (bearer/basic/header/query/generic).
  service?: string;
  // The type carries a server-side connectivity test (test-on-save).
  testable?: boolean;
  // A testable type that needs an operator-supplied base URL to probe (self-hosted/configurable).
  needsBase?: boolean;
  // The injection param name is operator-supplied (stored in VaultEntry.paramName).
  needsParamName?: boolean;
  // Multi-field value (e.g. langfuse). Each field is rendered as a separate input.
  fields?: { key: string; masked?: boolean }[];
  // The type supports a persistent base URL (stored in VaultEntry.baseUrl).
  supportsBaseUrl?: boolean;
  // When true, a non-empty baseUrl is required (mirrors server-side requiresBaseUrl).
  requiresBaseUrl?: boolean;
  // When true, the VALUE is a server-managed JSON blob (created empty, populated by a connect flow
  // like OAuth). The form renders no value/field inputs and submits `value: {}` (mirrors
  // server-side managedBlob).
  managedBlob?: boolean;
}

export const SECRET_TYPE_META: Record<SecretTypeId, SecretTypeMeta> = {
  generic: { supportsBaseUrl: true },
  bearer_token: { supportsBaseUrl: true },
  header: { needsParamName: true, supportsBaseUrl: true },
  basic_auth: { supportsBaseUrl: true },
  query: { needsParamName: true, supportsBaseUrl: true },
  openai: { service: "openai", testable: true },
  anthropic: { service: "anthropic", testable: true },
  gemini: { service: "gemini", testable: true },
  deepseek: { service: "deepseek", testable: true },
  openrouter: { service: "openrouter", testable: true },
  openai_compatible: {
    service: "openai_compatible",
    testable: true,
    needsBase: true,
    supportsBaseUrl: true,
    requiresBaseUrl: true,
  },
  elevenlabs: { service: "elevenlabs", testable: true },
  asaas: { service: "asaas", testable: true },
  chatwoot_api_token: {
    service: "chatwoot",
    testable: true,
    needsBase: true,
    supportsBaseUrl: true,
    requiresBaseUrl: true,
  },
  langfuse: {
    service: "langfuse",
    supportsBaseUrl: true,
    requiresBaseUrl: true,
    fields: [{ key: "publicKey" }, { key: "secretKey", masked: true }],
  },
  google_oauth: {
    service: "google",
    fields: [{ key: "clientId" }, { key: "clientSecret", masked: true }],
  },
  mcp_oauth: {
    service: "mcp",
    supportsBaseUrl: true,
    requiresBaseUrl: true,
    managedBlob: true,
  },
  // stdio MCP env var: value = token, paramName = the env var name (e.g. API_TOKEN).
  mcp_env: { service: "mcp", needsParamName: true },
};

export function isTestableSecretType(id: string | null | undefined): boolean {
  return !!(id && SECRET_TYPE_META[id as SecretTypeId]?.testable);
}

export function secretTypeNeedsBase(id: string | null | undefined): boolean {
  return !!(id && SECRET_TYPE_META[id as SecretTypeId]?.needsBase);
}

export function secretTypeNeedsParamName(
  id: string | null | undefined,
): boolean {
  return !!(id && SECRET_TYPE_META[id as SecretTypeId]?.needsParamName);
}

export function secretTypeFields(
  id: string | null | undefined,
): { key: string; masked?: boolean }[] | null {
  return id ? (SECRET_TYPE_META[id as SecretTypeId]?.fields ?? null) : null;
}

export function secretTypeSupportsBaseUrl(
  id: string | null | undefined,
): boolean {
  return !!(id && SECRET_TYPE_META[id as SecretTypeId]?.supportsBaseUrl);
}

// The client half of the server's gate (#504). A base URL stored on a kind that has no use for one is
// no longer prepended to anything, so the console must not decide with it either: the tool editor
// accepts a RELATIVE url_template only when a credential supplies a base, and reading the stray value
// there would let an operator save a tool the runtime refuses to build.
//
// The carve-out is the server's, to the letter: a kind this build does not KNOW refuses nothing, so a
// row written by a newer build keeps whatever it has. `Object.hasOwn` and not `in`, because `in`
// walks the prototype and would call `toString` a known credential type.
export function secretTypeRefusesBaseUrl(
  id: string | null | undefined,
): boolean {
  return (
    !!id &&
    Object.hasOwn(SECRET_TYPE_META, id) &&
    !SECRET_TYPE_META[id as SecretTypeId].supportsBaseUrl
  );
}

export function dialableBaseUrl(
  kind: string | null | undefined,
  baseUrl: string | null | undefined,
): string | null {
  return secretTypeRefusesBaseUrl(kind) ? null : (baseUrl ?? null);
}

export function secretTypeRequiresBaseUrl(
  id: string | null | undefined,
): boolean {
  return !!(id && SECRET_TYPE_META[id as SecretTypeId]?.requiresBaseUrl);
}

export function secretTypeIsManagedBlob(
  id: string | null | undefined,
): boolean {
  return !!(id && SECRET_TYPE_META[id as SecretTypeId]?.managedBlob);
}

export function secretTypeService(
  id: string | null | undefined,
): string | undefined {
  return id ? SECRET_TYPE_META[id as SecretTypeId]?.service : undefined;
}
