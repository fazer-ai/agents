import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import {
  isExpectedResult,
  normalizeExpectedStatuses,
} from "@/graph/tools/http-status";
import { AppError } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { normalizeToolShapes } from "@/modules/tool-definitions/normalize";
import { resolveSecretInjection } from "@/modules/vault/secret-types";
import { normalizeToolName } from "./toolName";

// Custom HTTP tools (from ToolDefinition rows). The agent calls them mid-turn; each is a thin,
// SECURITY-bounded HTTP client. Hard rules (hardened spec, anti prompt-injection):
//   - interpolation touches PATH/QUERY/BODY only, NEVER the origin (scheme://host:port);
//   - the final host must be in the per-tool allowlist AND pass the SSRF guard before any fetch;
//   - the credential (resolved by name from the vault) flows ONLY where the operator writes {{secret}}
//     (headers, the URL path/query, a raw body, a fixed value) or via typed auto-injection — never
//     into the model-visible schema/return or a trace (the origin pin keeps {{secret}} out of the host);
//   - no redirects, https-only (unless allowHttp), bounded timeout + response size.
// Fields carry a `source` (n8n-style): "ai" (the model fills it; appears in the tool schema) or
// "fixed" (a constant/context template sent without the model). Conversation/contact context
// (e.g. {{conversation_id}}) and {{secret}} are available in fixed values, headers, the URL and a raw
// body; the secret is interpolated server-side and never enters the model schema or a trace.

export interface HttpToolDef {
  name: string;
  description?: string | null;
  method: string;
  urlTemplate: string;
  allowedHosts: string[];
  headers: Record<string, string>;
  inputSchema: unknown;
  // Query-string params (Record<string,string> of templates), applied for ANY method. Each value is
  // interpolated (fixed/context/{{secret}}/{{aiField}}) and added to the URL's searchParams.
  query?: unknown;
  // Body shape: { mode: "kv", rows: [{key,value}] } | { mode: "raw", raw } | legacy { mode: "fields" }.
  // "kv" assembles JSON from explicit rows (a lone {{aiField}} value keeps the AI's type); "raw" sends
  // the interpolated template; legacy "fields"/absent assembles JSON from the non-path input fields.
  body?: unknown;
  // HTTP statuses this tool declares as RESULTS rather than integration failures (issue #59).
  // Empty/absent keeps issue #40's default, where every non-2xx is a failure. See ./http-status.
  expectedStatuses?: number[] | null;
  credentialRef?: string | null;
  // Predefined secret type of the credential (item 8). When set (non-generic), the resolved secret is
  // auto-injected per the type (header/bearer/basic/query) — the operator need not write {{secret}}.
  credentialKind?: string | null;
  // Header/query param name for generic `header`/`query` credential kinds (from VaultEntry.paramName).
  // Only relevant when credentialKind is "header" or "query" (needsParamName types).
  credentialParamName?: string | null;
  // baseUrl from the vault entry (entry.baseUrl). When urlTemplate starts with /, this is prepended
  // to form the effective template. Required for relative templates; ignored for absolute ones.
  credentialBaseUrl?: string | null;
  // Resolved ack message (null when the tool's ack is disabled): posted to the customer before the
  // tool runs. The ack flows only into the conversation, never into the request — it is not a secret.
  ackMessage?: string | null;
}

export interface HttpToolDeps {
  // Resolves a vault secret by reference (a short scoped DB read; no network). Returns null when
  // the credential is missing.
  resolveCredential: (ref: string) => Promise<string | null>;
  allowHttp?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseChars?: number;
  // Posts a "I'll look into that…" ack to the customer before a slow tool runs (best-effort). Wired
  // only on a real conversation; absent in the playground (no client / no conversation).
  emitAck?: (message: string) => Promise<void>;
  // Conversation/contact context for {{placeholder}} interpolation in fixed fields, headers, the URL
  // and a raw body (e.g. {{conversation_id}}, {{contact_name}}). NEVER a secret.
  context?: Record<string, string>;
}

// Scalar types serialize cleanly into a string (query/header/path); the richer types (enum/array/
// object) are body-only (array/object flatten to "a,b"/"[object Object]" outside JSON).
type ScalarType = "string" | "integer" | "number" | "boolean";
type FieldType = ScalarType | "enum" | "array" | "object";

const FIELD_TYPES = new Set<FieldType>([
  "string",
  "integer",
  "number",
  "boolean",
  "enum",
  "array",
  "object",
]);
const SCALAR_TYPES = new Set<ScalarType>([
  "string",
  "integer",
  "number",
  "boolean",
]);
function coerceFieldType(t: unknown): FieldType {
  return typeof t === "string" && FIELD_TYPES.has(t as FieldType)
    ? (t as FieldType)
    : "string";
}
function coerceScalarType(t: unknown): ScalarType {
  return typeof t === "string" && SCALAR_TYPES.has(t as ScalarType)
    ? (t as ScalarType)
    : "string";
}

interface FieldSpec {
  type?: FieldType;
  required?: boolean;
  description?: string;
  source?: "ai" | "fixed";
  value?: string;
  // enum: the allowed string values. array: the element scalar type. Ignored for other types.
  enumValues?: string[];
  itemType?: ScalarType;
}

interface ParsedField {
  name: string;
  type: FieldType;
  required: boolean;
  description?: string;
  source: "ai" | "fixed";
  value: string;
  enumValues?: string[];
  itemType?: ScalarType;
}

// Compact tool input schema: a map of field name → {type, required?, description?, enumValues?,
// itemType?, source?, value?}. This is intentionally NOT full JSON Schema — the set of authors is
// small (us / the operator) and a narrow shape keeps the surface auditable. New rows carry only
// AI-filled fields (fixed values live in body/query/headers); legacy rows may still carry
// source:"fixed"+value (honored here for back-compat). Old specs lack `source` ⇒ default "ai".
function parseFields(raw: unknown): ParsedField[] {
  if (!raw || typeof raw !== "object") return [];
  const out: ParsedField[] = [];
  for (const [name, spec] of Object.entries(raw as Record<string, FieldSpec>)) {
    const s = (spec ?? {}) as FieldSpec;
    out.push({
      name,
      type: coerceFieldType(s.type),
      required: !!s.required,
      description: s.description,
      source: s.source === "fixed" ? "fixed" : "ai",
      value: typeof s.value === "string" ? s.value : "",
      enumValues: Array.isArray(s.enumValues)
        ? s.enumValues.filter((v): v is string => typeof v === "string")
        : undefined,
      itemType: s.itemType ? coerceScalarType(s.itemType) : undefined,
    });
  }
  return out;
}

function zodForScalar(t: ScalarType): z.ZodTypeAny {
  return t === "integer"
    ? z.number().int()
    : t === "number"
      ? z.number()
      : t === "boolean"
        ? z.boolean()
        : z.string();
}

function zodFor(f: ParsedField): z.ZodTypeAny {
  let zt: z.ZodTypeAny;
  if (f.type === "enum") {
    // z.enum requires a non-empty tuple; an enum with no values falls back to a free string.
    zt =
      f.enumValues && f.enumValues.length > 0
        ? z.enum(f.enumValues as [string, ...string[]])
        : z.string();
  } else if (f.type === "array") {
    zt = z.array(zodForScalar(f.itemType ?? "string"));
  } else if (f.type === "object") {
    // Generic JSON object: validates the AI passed an object; contents are free-form.
    zt = z.record(z.string(), z.unknown());
  } else {
    zt = zodForScalar(f.type);
  }
  if (f.description) zt = zt.describe(f.description);
  if (!f.required) zt = zt.optional();
  return zt;
}

// Backward-compatible export (used by tests): the zod schema for the AI-filled fields only. A
// JSON-Schema-shaped value is converted to the compact map first, mirroring buildHttpTool.
export function parseToolInputSchema(raw: unknown): z.ZodObject<z.ZodRawShape> {
  const { shapes } = normalizeToolShapes({ inputSchema: raw });
  const shape: Record<string, z.ZodType> = {};
  for (const f of parseFields(shapes.inputSchema)) {
    if (f.source === "ai") shape[f.name] = zodFor(f);
  }
  return z.object(shape);
}

interface KvRow {
  key: string;
  value: string;
}
type BodyConfig =
  | { mode: "raw"; raw: string }
  | { mode: "kv"; rows: KvRow[] }
  | { mode: "fields" };

function parseBody(raw: unknown): BodyConfig {
  if (raw && typeof raw === "object") {
    const b = raw as Record<string, unknown>;
    if (b.mode === "raw") {
      return { mode: "raw", raw: typeof b.raw === "string" ? b.raw : "" };
    }
    if (b.mode === "kv") {
      const rows: KvRow[] = Array.isArray(b.rows)
        ? b.rows
            .map((r) => {
              const row = (r ?? {}) as Record<string, unknown>;
              return {
                key: typeof row.key === "string" ? row.key : "",
                value: typeof row.value === "string" ? row.value : "",
              };
            })
            .filter((r) => r.key.trim())
        : [];
      return { mode: "kv", rows };
    }
  }
  // Legacy / absent ⇒ assemble JSON from the non-path input fields.
  return { mode: "fields" };
}

// Query params: a Record<string,string> of templates (read like headers). A non-string stored
// value is coerced to string so it still interpolates cleanly.
function parseQuery(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = typeof v === "string" ? v : String(v);
    }
  }
  return out;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
// A value that is EXACTLY one placeholder (no surrounding text). Used by the kv body to keep an
// AI-supplied value's original type instead of coercing it to a string.
const LONE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;
// The model-supplied (optional) holding message arg; consumed for the ack, NEVER sent in the request.
const WAIT_MESSAGE_ARG = "__wait_message";

function interpolate(
  template: string,
  lookup: (name: string) => string | undefined,
): string {
  return template.replace(PLACEHOLDER, (_, name: string) => lookup(name) ?? "");
}

function placeholderNames(template: string): Set<string> {
  const names = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) names.add(m[1] as string);
  return names;
}

// LangChain/provider tool names must be [a-zA-Z0-9_-]; the operator-friendly stored name (which may
// carry spaces/accents) is normalized here via the shared helper (NFD + lowercase + "_").
export const sanitizeToolName = normalizeToolName;

export function buildHttpTool(
  def: HttpToolDef,
  deps: HttpToolDeps,
): StructuredToolInterface {
  const context = deps.context ?? {};
  // NOTE: self-heal shapes authored before write-time normalization existed (or written straight to the
  // DB): a JSON-Schema-shaped inputSchema becomes the compact map and known single-brace {var}
  // placeholders become {{var}}, so pre-fix rows work without re-creation.
  const { shapes } = normalizeToolShapes(
    {
      urlTemplate: def.urlTemplate,
      query: def.query,
      headers: def.headers,
      body: def.body,
      inputSchema: def.inputSchema,
    },
    {},
    Object.keys(context),
  );
  const urlTemplate = shapes.urlTemplate as string;
  const headerTemplates = (shapes.headers ?? {}) as Record<string, string>;
  const fields = parseFields(shapes.inputSchema);
  const bodyCfg = parseBody(shapes.body);
  const method = def.method.toUpperCase();
  const isBodyMethod =
    method === "POST" || method === "PUT" || method === "PATCH";
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxChars = deps.maxResponseChars ?? 4000;
  const expectedStatuses = normalizeExpectedStatuses(def.expectedStatuses);

  // Schema = the AI-filled fields. When an ack is configured, the model MUST write the holding message
  // itself (__wait_message is required, not optional): the operator's ackMessage is only a TONE example,
  // never sent verbatim. A missing/empty value fails zod validation, so the model gets the error and
  // retries the call with a message. The arg is popped for the ack and never reaches the request.
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) if (f.source === "ai") shape[f.name] = zodFor(f);
  if (def.ackMessage) {
    shape[WAIT_MESSAGE_ARG] = z
      .string()
      .min(
        1,
        "A wait message is required: write a short message to send to the user before this tool runs.",
      )
      .describe(
        `REQUIRED. A short holding message YOU write and that is sent to the user before this (slow) tool runs, in the tone of: "${def.ackMessage}". Do not leave it empty.`,
      );
  }
  const schema = z.object(shape);

  // Resolve relative template: if urlTemplate starts with /, credential must supply a baseUrl.
  const isRelative = urlTemplate.startsWith("/");
  if (isRelative && !def.credentialBaseUrl) {
    throw new AppError(
      `tool ${def.name}: relative urlTemplate requires a credential with a base URL`,
      400,
    );
  }
  const effectiveTemplate = isRelative
    ? `${def.credentialBaseUrl}${urlTemplate}`
    : urlTemplate;

  return failableTool(
    async (input: Record<string, unknown>) => {
      // 0. Ack (the model-written holding message): required when an ack is configured. The schema
      // already enforces non-empty, so this is a defensive guard — if a provider somehow let an empty
      // value through, return an error string (and DON'T run the request) so the model retries the
      // call WITH a message, instead of sending a blank/placeholder ack. Best-effort emit — a failed
      // ack send must never block the actual tool call. Only wired on a real conversation (deps.emitAck
      // is undefined in the playground, where the arg is still required but simply not sent).
      if (def.ackMessage) {
        const dyn = input[WAIT_MESSAGE_ARG];
        const msg = typeof dyn === "string" ? dyn.trim() : "";
        if (!msg) {
          return "Error: a wait message is required. Call this tool again with a short __wait_message to send to the user before it runs.";
        }
        if (deps.emitAck) await deps.emitAck(msg);
      }

      // Resolve the credential up front. It flows ONLY via {{secret}} into the request the operator
      // wrote (headers, the URL path/query, a raw body, a fixed value) and via the typed auto-injection
      // below — never into the model-visible schema/return or a trace. The origin pin keeps {{secret}}
      // out of the host, so it can only land in the path/query.
      let secret: string | null = null;
      if (def.credentialRef) {
        secret = await deps.resolveCredential(def.credentialRef);
      }

      // Precompute fixed-field values (interpolated with CONTEXT + {{secret}} — never model input).
      // NOTE: unresolved dependencies interpolate to "" (headers/body semantics) but are tracked
      // per field, so the URL guard below can refuse to fetch with an incomplete URL segment.
      const ctxLookup = (n: string) => (n in context ? context[n] : undefined);
      const fixedValues: Record<string, string> = {};
      const fixedMissingDeps = new Map<string, Set<string>>();
      for (const f of fields) {
        if (f.source === "fixed") {
          const missing = new Set<string>();
          fixedValues[f.name] = interpolate(f.value, (n) => {
            const v = n === "secret" ? secret : ctxLookup(n);
            if (v == null) missing.add(n);
            return v ?? undefined;
          });
          if (missing.size > 0) fixedMissingDeps.set(f.name, missing);
        }
      }

      // Resolver for URL / body / query (NO secret): AI input → fixed value → context.
      const valueLookup = (n: string): string | undefined => {
        if (n in input && input[n] != null) return String(input[n]);
        if (n in fixedValues) return fixedValues[n];
        if (n in context) return context[n];
        return undefined;
      };

      // 1. Build the URL by interpolating the RAW template (values URL-encoded so a hostile value
      // cannot break out of its path/query segment), then assert the origin is unchanged — the
      // origin is NEVER interpolatable. A probe with neutral placeholders gives the expected
      // origin; if the real interpolation differs, a placeholder tried to alter the host.
      let expectedOrigin: string;
      try {
        expectedOrigin = new URL(effectiveTemplate.replace(PLACEHOLDER, "_"))
          .origin;
      } catch {
        throw new AppError(`tool ${def.name}: invalid urlTemplate`, 400);
      }
      const pathFields = placeholderNames(effectiveTemplate);
      const isAiFieldName = (n: string): boolean =>
        fields.some((f) => f.name === n && f.source !== "fixed");
      // NOTE: a URL placeholder that resolves to nothing produces a request that cannot be right (an
      // empty path segment / dangling query value). Instead of silently sending it, tell the model
      // which value is missing so it can retry with the field (or explain what it needs).
      const missingUrlNames = new Set<string>();
      const interpolated = interpolate(effectiveTemplate, (n) => {
        const v = n === "secret" ? secret : valueLookup(n);
        if (v == null) {
          missingUrlNames.add(n);
          return undefined;
        }
        // NOTE: a fixed field whose own {{secret}}/context dependency was unavailable resolved to
        // "" above; surface the missing dependency instead of fetching an incomplete URL. AI input
        // never shadows a fixed name (the schema excludes fixed fields), so the map lookup is safe.
        const missingDeps = !(n in input && input[n] != null)
          ? fixedMissingDeps.get(n)
          : undefined;
        if (missingDeps) {
          for (const d of missingDeps) missingUrlNames.add(d);
          return undefined;
        }
        return encodeURIComponent(v);
      });
      if (missingUrlNames.size > 0) {
        // NOTE: an unresolved {{secret}} is an operator/config problem (missing or unresolvable
        // credential): the model can never supply it, so a retry hint would just loop. Throw like
        // the other config errors in this file.
        if (missingUrlNames.has("secret")) {
          throw new AppError(
            `tool ${def.name}: the URL requires {{secret}} (directly or via a fixed field) but no credential resolved`,
            400,
          );
        }
        // NOTE: context variables, fixed-field dependencies and unknown tokens are injected by the
        // platform, never supplied by the model, so those also throw; the retry message is reserved
        // for placeholders the model can actually provide (AI-source input fields).
        const nonInput = [...missingUrlNames].filter((n) => !isAiFieldName(n));
        if (nonInput.length > 0) {
          throw new AppError(
            `tool ${def.name}: no value available for URL placeholder(s) ${nonInput
              .map((n) => `{{${n}}}`)
              .join(", ")} (resolved from context/config, not model input)`,
            400,
          );
        }
        return `Error: no value available for URL placeholder(s): ${[
          ...missingUrlNames,
        ]
          .map((n) => `{{${n}}}`)
          .join(
            ", ",
          )}. Call the tool again providing the missing input field(s).`;
      }
      let url: URL;
      try {
        url = new URL(interpolated);
      } catch {
        throw new AppError(`tool ${def.name}: invalid urlTemplate`, 400);
      }
      if (url.origin !== expectedOrigin) {
        throw new AppError(
          `tool ${def.name}: interpolation altered the origin`,
          400,
        );
      }

      // For relative templates the host comes from the credential's baseUrl, which is implicitly
      // trusted — the check passes when the list is empty OR the host is listed OR the host
      // matches the credential base host. For absolute templates the current strict behavior
      // (must be in the non-empty allowlist) is unchanged.
      const credHost =
        isRelative && def.credentialBaseUrl
          ? new URL(def.credentialBaseUrl).hostname
          : null;
      if (
        def.allowedHosts.length > 0 &&
        !def.allowedHosts.includes(url.hostname) &&
        !(isRelative && credHost === url.hostname)
      ) {
        throw new AppError(
          `tool ${def.name}: host ${url.hostname} not in allowlist`,
          400,
        );
      }

      // 2. Headers: the credential is available here via {{secret}}, alongside context + field values
      // (e.g. an {{conversation_id}} header).
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(headerTemplates)) {
        headers[k] = interpolate(String(v), (n) =>
          n === "secret" ? (secret ?? "") : valueLookup(n),
        );
      }

      // 3. Query params (any method), then the body (write methods). Context + {{secret}} resolve in
      // query values, fixed values and the raw body; {{aiField}} resolves from model input.
      const lookupWithSecret = (n: string): string | undefined =>
        n === "secret" ? (secret ?? "") : valueLookup(n);

      // Query: explicit Record<string,string> templates, applied for ANY method. Interpolated but NOT
      // pre-encoded (searchParams.set encodes once — pre-encoding would double-encode). A param already
      // on the URL (hand-written) wins; an empty resolution is skipped.
      const queryMap = parseQuery(shapes.query);
      const hasExplicitQuery = Object.keys(queryMap).length > 0;
      for (const [k, tpl] of Object.entries(queryMap)) {
        const v = interpolate(tpl, lookupWithSecret);
        if (v !== "" && !url.searchParams.has(k)) url.searchParams.set(k, v);
      }

      let body: string | undefined;
      if (isBodyMethod) {
        const hasContentType = Object.keys(headers).some(
          (h) => h.toLowerCase() === "content-type",
        );
        if (!hasContentType) headers["Content-Type"] = "application/json";
        if (bodyCfg.mode === "raw") {
          body = interpolate(bodyCfg.raw, lookupWithSecret);
        } else if (bodyCfg.mode === "kv") {
          // Explicit key/value rows. A value that is a LONE {{aiField}} the model supplied keeps its
          // original type (number/array/object/bool); a known aiField the model OMITTED is skipped
          // (matches the legacy fields behavior — never emit ""); anything else (context/secret/fixed/
          // mixed text) interpolates to a string.
          // NOTE: null-prototype, because `payload[k] = v` on a plain object hits the INHERITED
          // setter when k is "__proto__" — the assignment succeeds, no own property is created, and
          // JSON.stringify drops the row without a word. That is the same silent payload loss this
          // area is about (issue #150), and fixing it here fixes it for rows already stored.
          const payload: Record<string, unknown> = Object.create(null);
          for (const { key, value } of bodyCfg.rows) {
            const k = key.trim();
            if (!k) continue;
            const ph = value.match(LONE_PLACEHOLDER)?.[1];
            if (ph && ph in input) {
              if (input[ph] != null) payload[k] = input[ph];
            } else if (ph && isAiFieldName(ph)) {
              // known aiField the model omitted → omit the key
            } else {
              payload[k] = interpolate(value, lookupWithSecret);
            }
          }
          body = JSON.stringify(payload);
        } else {
          // Legacy "fields": assemble JSON from the non-path input fields (AI input keeps its type; a
          // fixed field contributes its interpolated value).
          // NOTE: null-prototype, because `payload[k] = v` on a plain object hits the INHERITED
          // setter when k is "__proto__" — the assignment succeeds, no own property is created, and
          // JSON.stringify drops the row without a word. That is the same silent payload loss this
          // area is about (issue #150), and fixing it here fixes it for rows already stored.
          const payload: Record<string, unknown> = Object.create(null);
          for (const f of fields) {
            if (pathFields.has(f.name)) continue;
            if (f.source === "fixed") payload[f.name] = fixedValues[f.name];
            else if (input[f.name] != null) payload[f.name] = input[f.name];
          }
          body = JSON.stringify(payload);
        }
      } else if (bodyCfg.mode === "fields" && !hasExplicitQuery) {
        // Legacy derivation: non-path fields → query, ONLY for a legacy "fields" body with no explicit
        // query (a new tool sets kv/raw + explicit query, so it never double-adds its params here).
        for (const f of fields) {
          if (pathFields.has(f.name)) continue;
          const v = f.source === "fixed" ? fixedValues[f.name] : input[f.name];
          if (v != null && !url.searchParams.has(f.name)) {
            url.searchParams.set(f.name, String(v));
          }
        }
      }

      // 3b. Auto-inject the credential per its predefined secret type (item 8), so a typed
      // credential needs no hand-written header. Skips if the operator already set the target header/
      // param manually (their explicit value wins, including a {{secret}} they wrote themselves).
      if (secret && def.credentialKind) {
        const inj = resolveSecretInjection(
          def.credentialKind,
          secret,
          def.credentialParamName,
        );
        if (inj?.target === "header") {
          const already = Object.keys(headers).some(
            (h) => h.toLowerCase() === inj.name.toLowerCase(),
          );
          if (!already) headers[inj.name] = inj.value;
        } else if (inj?.target === "query" && !url.searchParams.has(inj.name)) {
          url.searchParams.set(inj.name, inj.value);
        }
      }

      // 4. SSRF guard on the FINAL URL, immediately before the fetch.
      await assertSafeOutboundUrl(url.toString(), {
        allowHttp: deps.allowHttp,
      });

      // 5. Fetch — no redirects, bounded timeout.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(url.toString(), {
          method,
          headers,
          body,
          redirect: "error",
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      const trimmed =
        text.length > maxChars
          ? `${text.slice(0, maxChars)}…[truncated]`
          : text;
      // NOTE: By default every non-2xx is an integration failure worth alerting on — a broken
      // credential, a provider outage, a rejected payload (issue #40) — unless the operator declared
      // this status a result for this tool (issue #59). The model sees the same "HTTP <status>" body
      // in both cases; only the failure marking moves.
      const resultText = `HTTP ${res.status}\n${trimmed}`;
      return isExpectedResult(res.status, expectedStatuses)
        ? resultText
        : toolFailure(resultText);
    },
    {
      name: sanitizeToolName(def.name),
      description: def.description ?? `HTTP tool ${def.name}`,
      schema,
    },
  );
}
