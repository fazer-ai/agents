// Whether an HTTP tool's request will actually carry the credential attached to it. Issue #504: a
// tool can reference a `generic` credential while nothing in its templates interpolates `{{secret}}`.
// Nothing refuses that, and nothing should — a tool may legitimately hold a reference it does not
// wire yet — but the failure it produces is unreadable: the request goes out UNAUTHENTICATED and the
// upstream answers 401/403, which reads as a bad credential rather than as one that was never sent.
//
// THE QUESTION IS NOT "does a template mention {{secret}}". It is "does the credential reach the
// request", and the two come apart in four ways the runtime decides and a text scan does not see: a
// body is only assembled for POST/PUT/PATCH, a fixed field's value only leaves if something emitted
// references it, a typed credential's auto-injection is skipped when the operator already wrote its
// target header or query param, and a stored single-brace `{secret}` is normalized at BUILD time and
// does reach. Each of those was a wrong answer in the first draft of this file, and each is fenced by
// executing the real tool rather than by a list written here.

import {
  INJECTING_MECHANISM_KIND_IDS,
  isNonInjectableSecret,
  resolveSecretInjection,
} from "@/modules/vault/secret-types";
import { normalizeToolShapes, type ToolShapePatch } from "./normalize";
import { DEFAULT_HTTP_METHOD } from "./service";

// The SAME grammar the runtime interpolates with (`PLACEHOLDER` in graph/tools/http.ts): the braces
// take surrounding whitespace, so a reader matching only the tight spelling would call a working
// `{{ secret }}` unused and warn about a tool that is wired correctly.
//
// Read as TOKENS rather than by compiling a regex around each name, and that is not a style choice:
// an input-schema key is not held to this grammar, so `new RegExp(\`…${name}…\`)` on a field called
// `a[b` throws — out of `tool_create`, before its try block, as an unhandled error rather than a
// write result. Extracting the names a template actually carries has no such edge, and it answers
// the same question the runtime asks: a name outside `[a-zA-Z0-9_]` can never be a placeholder.
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function namesIn(template: string): Set<string> {
  return new Set(
    [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string),
  );
}

const mentions = (templates: string[], name: string): boolean =>
  templates.some((t) => namesIn(t).has(name));

// What is left of a template once every placeholder is gone. Non-empty means the interpolation can
// never produce the empty string, whatever the placeholders resolve to — which is the difference
// between a query value the runtime is sure to set and one it may skip.
const literalPartOf = (template: string): string =>
  template.replace(PLACEHOLDER, "");

// Mirrors `isBodyMethod` in graph/tools/http.ts. DELETE is deliberately absent there — a DELETE tool
// carrying a raw body sends none of it — and a copy of that list which quietly included DELETE would
// call such a tool wired.
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringValues(v: unknown): string[] {
  return isPlainObject(v)
    ? Object.values(v).filter((x): x is string => typeof x === "string")
    : [];
}

// The query map as the runtime reads it (`parseQuery`): a null/undefined value is dropped and
// everything else is STRINGIFIED, so `{ token: 123 }` is a real, non-empty query value. Reading only
// the strings would call that entry absent and then conclude the credential is auto-injected into a
// parameter the operator has already taken.
function queryMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

// The URL the runtime will parse, with the placeholders neutralized the way `buildHttpTool` does for
// its own origin probe. The base is only there so a relative template parses; nothing reads the host.
function parseUrlTemplate(urlTemplate: unknown): URL | null {
  if (typeof urlTemplate !== "string") return null;
  try {
    return new URL(
      urlTemplate.replace(PLACEHOLDER, "_"),
      "https://placeholder.invalid",
    );
  } catch {
    return null;
  }
}

// The query keys the URL template already carries. The runtime applies the explicit query map with
// `if (v !== "" && !url.searchParams.has(k))`, so a key the template spells wins and the map's value
// for it is DISCARDED — never interpolated into anything that leaves.
//
// Parsed as a URL rather than split on "?", because a query VALUE may hold one of its own — a
// `redirect=https://a.test/?x=1&token=fixed` keeps everything after the second question mark, which
// `split("?")[1]` throws away and `searchParams` does not.
function urlQueryKeys(urlTemplate: unknown): Set<string> {
  const url = parseUrlTemplate(urlTemplate);
  return url ? new Set([...url.searchParams.keys()]) : new Set();
}

// The URL as far as it is TRANSMITTED. A fragment is not sent to the upstream — measured on a real
// socket, the server reads `/x?a=1` for a request to `/x?a=1#token=…` — so a credential written only
// there authenticates nothing and produces exactly the 401 this warning exists to explain.
function transmittedUrl(urlTemplate: unknown): string[] {
  if (typeof urlTemplate !== "string") return [];
  return [urlTemplate.split("#")[0] ?? ""];
}

// The explicit query entries that survive to the request: everything the URL template does not
// already spell.
function reachingQuery(shapes: ToolShapePatch): Record<string, string> {
  const taken = urlQueryKeys(shapes.urlTemplate);
  return Object.fromEntries(
    Object.entries(queryMap(shapes.query)).filter(([k]) => !taken.has(k)),
  );
}

function bodyTemplates(body: unknown): string[] {
  if (!isPlainObject(body)) return [];
  if (body.mode === "raw" && typeof body.raw === "string") return [body.raw];
  if (body.mode === "kv" && Array.isArray(body.rows)) {
    return body.rows
      .filter((r): r is Record<string, unknown> => isPlainObject(r))
      .map((r) => r.value)
      .filter((v): v is string => typeof v === "string");
  }
  return [];
}

// A legacy `fields` body (mode absent, or anything that is not raw/kv) assembles its payload from the
// declared fields, so EVERY non-path fixed field is emitted without being referenced. Read from the
// same shape `parseBody` reads.
function isLegacyFieldsBody(body: unknown): boolean {
  if (!isPlainObject(body)) return true;
  return body.mode !== "raw" && body.mode !== "kv";
}

function fixedFields(schema: unknown): { name: string; value: string }[] {
  if (!isPlainObject(schema)) return [];
  const out: { name: string; value: string }[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    // `source === "fixed"` is not a detail: `buildHttpTool` reads `s.source === "fixed" ? "fixed" :
    // "ai"` and precomputes only the fixed values with the secret in scope, so a `{{secret}}` written
    // into an AI field's `value` is never interpolated.
    if (isPlainObject(spec) && spec.source === "fixed") {
      if (typeof spec.value === "string") out.push({ name, value: spec.value });
    }
  }
  return out;
}

// Every string the runtime interpolates AND SENDS, for this method and this row. The second half is
// what a site list alone gets wrong: a template that is assembled and then discarded carries nothing,
// so counting it as usage silences the warning for a tool whose credential never leaves.
export function reachableTemplates(
  method: string | null | undefined,
  shapes: ToolShapePatch,
): string[] {
  const emitted: string[] = [...transmittedUrl(shapes.urlTemplate)];
  emitted.push(
    ...stringValues(shapes.headers),
    ...Object.values(reachingQuery(shapes)),
  );
  const m = (method ?? DEFAULT_HTTP_METHOD).toUpperCase();
  if (BODY_METHODS.has(m)) emitted.push(...bodyTemplates(shapes.body));

  const out = [...emitted];
  const legacy = isLegacyFieldsBody(shapes.body);
  for (const { name, value } of fixedFields(shapes.inputSchema)) {
    // A fixed value resolves from CONTEXT and the secret only, never from another fixed field, so
    // one level is the whole reach: it leaves if something emitted names it, or if the legacy body
    // assembles it without being asked.
    //
    // The legacy arm OVER-counts on purpose. `buildHttpTool` derives the query from those fields
    // only when there is no explicit query, and reproducing that condition would be a third copy of
    // the runtime's assembly rules for a case that costs a MISSED warning either way. Over-counting
    // here can only make this file too quiet; under-counting would make it warn about a tool that
    // works.
    if (legacy || mentions(emitted, name)) {
      out.push(value);
    }
  }
  return out;
}

// Whether the kind's own injection puts the credential on the request. Not `injection !== "none"`:
// the runtime SKIPS auto-injection when the operator already wrote the target header (any casing) or
// the target query param, letting their explicit value win — so a `bearer_token` attached to a tool
// that sets its own `Authorization` is never sent, which is exactly the shape this file exists to
// report.
function autoInjectionReaches(
  kind: string | null | undefined,
  paramName: string | null | undefined,
  shapes: ToolShapePatch,
): boolean {
  // The value is a probe, never a secret: `resolveSecretInjection` only needs a non-empty string to
  // answer WHERE the credential would go.
  const inj = resolveSecretInjection(kind, "probe", paramName);
  if (!inj) return false;
  if (inj.target === "header") {
    const names = isPlainObject(shapes.headers)
      ? Object.keys(shapes.headers)
      : [];
    return !names.some((h) => h.toLowerCase() === inj.name.toLowerCase());
  }
  // Query: the runtime injects unless the param is already on the URL — spelled in the template, or
  // set from the explicit query map, which it applies first and only for a value that resolves
  // NON-EMPTY. Whether a value resolves empty is knowable from its literal part alone: `prefix-{{id}}`
  // cannot come out empty whatever `id` is, while a bare `{{id}}` can, and only the first is sure to
  // take the parameter. Guessing that a placeholder always resolves would warn about a tool that is
  // wired.
  if (urlQueryKeys(shapes.urlTemplate).has(inj.name)) return false;
  const explicit = reachingQuery(shapes)[inj.name];
  const alwaysSet = explicit !== undefined && literalPartOf(explicit) !== "";
  return !alwaysSet;
}

export function credentialReachesRequest(
  kind: string | null | undefined,
  paramName: string | null | undefined,
  method: string | null | undefined,
  shapes: ToolShapePatch,
): boolean {
  if (mentions(reachableTemplates(method, shapes), "secret")) return true;
  return autoInjectionReaches(kind, paramName, shapes);
}

// The warning, or null when the wiring is fine. `kind` is the ATTACHED credential's kind, read off
// the vault entry; null (or a kind this build does not know) is the legacy `generic` and answers the
// same way, because that is how every other reader treats it.
//
// Scoped to kinds that CAN be sent: a `neverOutbound` credential on an HTTP tool is a worse problem
// with a different answer (it must not be sent at all, and the write boundary does not yet refuse
// it), and telling its operator to "write {{secret}} where the API expects it" would be advice to
// mail their stdio token to a third party.
//
// `shapes` is NORMALIZED here rather than by the caller, and that is the difference between reading
// the row and reading what the runtime reads: `buildHttpTool` runs the same normalization at BUILD
// time, so a legacy single-brace `{secret}` in a stored header is sent — and a caller that scanned
// the raw row would report a working tool as unwired on any update that did not happen to touch that
// template.
export function unusedCredentialWarning(
  facts: { kind: string | null; paramName: string | null },
  method: string | null | undefined,
  raw: ToolShapePatch,
): string | null {
  if (isNonInjectableSecret(facts.kind)) return null;
  const { shapes } = normalizeToolShapes(raw);
  if (credentialReachesRequest(facts.kind, facts.paramName, method, shapes)) {
    return null;
  }
  const kind = facts.kind ?? "generic";
  return `the attached credential is never sent: a "${kind}" credential puts nothing on this request by itself, and {{secret}} appears in none of the templates this ${(method ?? DEFAULT_HTTP_METHOD).toUpperCase()} actually emits — it goes out unauthenticated, and the upstream's 401/403 will look like a bad credential rather than one that was never wired. Write {{secret}} where the API expects it, or attach a credential whose type injects it (${INJECTING_MECHANISM_KIND_IDS.join(", ")}) into a header or query parameter the templates do not already set.`;
}
