// Whether an HTTP tool's request will actually carry the credential attached to it. Issue #504: a
// tool can reference a `generic` credential while nothing in its templates interpolates `{{secret}}`.
// Nothing refuses that, and nothing should — a tool may legitimately hold a reference it does not
// wire yet — but the failure it produces is unreadable: the request goes out UNAUTHENTICATED and the
// upstream answers 401/403, which reads as a bad credential rather than as one that was never sent.
//
// THIS FILE IS A COPY OF `buildHttpTool`'s ASSEMBLY, AND THAT IS THE ONE THING TO KNOW ABOUT IT.
// A warning cannot run the request it is warning about — the executor resolves DNS and SSRF-guards
// the final URL before it would reach a stubbed fetch — so what the credential does has to be read
// off the row instead. Four review rounds found nine places where the copy was thinner than the
// original, every one of them confirmed by executing the real tool, and the fence in
// tests/modules/tool-credential-wiring.test.ts is that same execution: one table, read as a tool
// definition the executor runs and as the shapes a write would store, asserting the two agree.
//
// Where the copy cannot be sure, it is written to err QUIET — the legacy-fields body counts every
// fixed field as emitted, a query value that may interpolate empty counts as not shadowing, a kv row
// the model may not overwrite keeps what came before it. The intent is that a gap costs a warning
// that does not appear rather than a warning about a tool that works.
//
// THAT IS AN INTENT, NOT A PROPERTY, and it has been violated twice — both times by a fix for a gap
// in the other direction. Collapsing kv rows by key (round 4) erased a value the model's silence
// leaves in the payload; substituting a fixed query key raw (round 5) read `token&x` as two
// parameters and called the credential's own shadowed. Each new rule here is a chance to warn about
// a working tool, so a rule that CANNOT be stated in the safe direction does not belong.
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
// A value that is EXACTLY one placeholder, which the kv body treats specially (`LONE_PLACEHOLDER` in
// graph/tools/http.ts): a lone AI field the model OMITS makes the runtime skip that row entirely.
const LONE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;

// What an UNRESOLVED placeholder becomes while the URL is parsed, and the one thing that matters
// about it is that NO param name can be this string: `validateParamName` holds those to
// `[A-Za-z0-9!#$%&'*+.^_`|~-]`, and parentheses are outside it. A key this file could not resolve is
// UNKNOWN, so a sentinel a real name could equal answers "that parameter is already taken" for a
// tool where it is not — and it did: `_` was the sentinel, and `paramName: "_"` is legal.
const UNRESOLVED_KEY = "((unresolved))";

function namesIn(template: string): Set<string> {
  return new Set(
    [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string),
  );
}

const mentions = (templates: string[], name: string): boolean =>
  templates.some((t) => namesIn(t).has(name));

// Whether interpolating this template can NEVER produce the empty string — the difference between a
// query value the runtime is sure to set and one it may skip, and therefore between a credential
// whose auto-injection is blocked and one whose is not.
//
// Two ways to be sure, and only two. What is left once every placeholder is gone is the first, and a
// placeholder naming a FIXED field that is itself sure is the second: the runtime resolves fixed
// values before it applies the query map, so `{{configured_token}}` over a fixed `abc` always
// arrives as `abc`. Everything else — AI input the model may omit, a context variable that may be
// absent — is unknowable here and answers "may be empty", which keeps this file quiet rather than
// warning about a tool that works.
//
// One level, because that is the runtime's: a fixed value interpolates from context and the secret,
// never from another fixed field.
function alwaysNonEmpty(
  template: string,
  fixed: Map<string, string>,
  resolveFixed = true,
): boolean {
  if (template.replace(PLACEHOLDER, "") !== "") return true;
  if (!resolveFixed) return false;
  for (const name of namesIn(template)) {
    const value = fixed.get(name);
    if (value !== undefined && alwaysNonEmpty(value, fixed, false)) return true;
  }
  return false;
}

function fixedValuesByName(schema: unknown): Map<string, string> {
  return new Map(fixedFields(schema).map((f) => [f.name, f.value]));
}

// Mirrors `isBodyMethod` in graph/tools/http.ts. DELETE is deliberately absent there — a DELETE tool
// carrying a raw body sends none of it — and a copy of that list which quietly included DELETE would
// call such a tool wired.
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Header values as the runtime reads them: `interpolate(String(v), …)` on every entry, whatever its
// JSON type. Filtering to strings dropped an `Authorization: ["Bearer {{secret}}"]` that the
// executor sends verbatim, and warned about the credential it was carrying.
function headerTemplates(v: unknown): string[] {
  return isPlainObject(v) ? Object.values(v).map((x) => String(x)) : [];
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

// The URL the runtime will parse. A placeholder naming a FIXED field is substituted first, because
// a query KEY can be one — `?{{auth_param}}=constant` over a fixed `auth_param: "token"` is the
// parameter `token`, and neutralizing it to `_` loses the key the runtime will find there. What is
// left is neutralized the way `buildHttpTool` does for its own origin probe. The base is only there
// so a relative template parses; nothing reads the host.
function parseUrlTemplate(
  urlTemplate: unknown,
  fixed: Map<string, string> = new Map(),
): URL | null {
  if (typeof urlTemplate !== "string") return null;
  const resolved = urlTemplate.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = fixed.get(name);
    // One level, like everywhere else here: a fixed value that is itself a template resolves from
    // context, which is unknowable, so it stays neutral.
    // ENCODED, because the runtime's interpolation is: `encodeURIComponent(v)` on every substituted
    // value. A fixed key holding a URL metacharacter (`token&x`) is ONE parameter of that name
    // there, and three separate ones here if the substitution goes in raw — which would read the
    // credential's own parameter as already taken and warn about a tool that injects it.
    return value !== undefined && namesIn(value).size === 0
      ? encodeURIComponent(value)
      : UNRESOLVED_KEY;
  });
  try {
    return new URL(resolved, "https://placeholder.invalid");
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
function urlQueryKeys(
  urlTemplate: unknown,
  fixed: Map<string, string> = new Map(),
): Set<string> {
  const url = parseUrlTemplate(urlTemplate, fixed);
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
  const taken = urlQueryKeys(
    shapes.urlTemplate,
    fixedValuesByName(shapes.inputSchema),
  );
  return Object.fromEntries(
    Object.entries(queryMap(shapes.query)).filter(([k]) => !taken.has(k)),
  );
}

// The declared fields the MODEL fills, and which of those it may leave out. `source` absent means
// "ai" (`s.source === "fixed" ? "fixed" : "ai"`), and a REQUIRED one is not optional in any executed
// call: zod rejects the invocation without it, so its row always overwrites.
interface AiFields {
  names: Set<string>;
  optional: Set<string>;
}

function aiFields(schema: unknown): AiFields {
  const names = new Set<string>();
  const optional = new Set<string>();
  if (!isPlainObject(schema)) return { names, optional };
  for (const [name, spec] of Object.entries(schema)) {
    const s = isPlainObject(spec) ? spec : {};
    if (s.source === "fixed") continue;
    names.add(name);
    if (s.required !== true) optional.add(name);
  }
  return { names, optional };
}

function bodyTemplates(body: unknown, ai: AiFields): string[] {
  if (!isPlainObject(body)) return [];
  if (body.mode === "raw" && typeof body.raw === "string") return [body.raw];
  if (body.mode === "kv" && Array.isArray(body.rows)) {
    // Collapsed by TRIMMED key, last one winning, because that is what `payload[k] = …` does row by
    // row: a `{{secret}}` written into a row a later row overwrites is assembled and thrown away.
    // An empty key is skipped there too, and its row emits nothing at all.
    //
    // Except when the later row is a LONE placeholder naming an AI field, which the runtime skips
    // when the model omits it — leaving the earlier row's value in the payload. That row does not
    // erase what came before it, it only MAY, so both survive here. Collapsing it unconditionally
    // warned about a tool that sends the credential on every call where the model stays quiet, which
    // is the one direction this file must not get wrong.
    const byKey = new Map<string, string[]>();
    for (const r of body.rows) {
      if (!isPlainObject(r) || typeof r.value !== "string") continue;
      const k = typeof r.key === "string" ? r.key.trim() : "";
      if (!k) continue;
      // Two independent questions about one row, and conflating them is how the last two rounds went
      // wrong in both directions.
      //
      // WHAT IT SENDS: a lone placeholder naming a declared AI field is filled by the MODEL, never
      // from the vault — `buildHttpTool` takes that branch before any credential interpolation. So a
      // row of `{{secret}}` on a tool that DECLARES an ai field called `secret` carries the model's
      // argument, not the credential, and counting it as usage would suppress the warning.
      //
      // WHETHER IT OVERWRITES: only an OPTIONAL one may be omitted, and only then does the earlier
      // row's value survive. A required field is on every executed call, so its row always wins.
      const lone = r.value.match(LONE_PLACEHOLDER)?.[1];
      const loneAi = lone !== undefined && ai.names.has(lone);
      const mayBeOmitted = lone !== undefined && ai.optional.has(lone);
      const carried = loneAi ? "" : r.value;
      byKey.set(
        k,
        mayBeOmitted ? [...(byKey.get(k) ?? []), carried] : [carried],
      );
    }
    return [...byKey.values()].flat();
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
    // A fixed field whose `value` is absent or not a string is still a fixed field — `parseFields`
    // gives it `""` — and its NAME is what the legacy query derivation puts on the URL, blocking a
    // query credential of the same name. Dropping it here lost the name, not just the value.
    if (isPlainObject(spec) && spec.source === "fixed") {
      out.push({
        name,
        value: typeof spec.value === "string" ? spec.value : "",
      });
    }
  }
  return out;
}

// Every string the runtime interpolates AND SENDS, for this method and this row. The second half is
// what a site list alone gets wrong: a template that is assembled and then discarded carries nothing,
// so counting it as usage silences the warning for a tool whose credential never leaves.
// The template the runtime actually requests. A urlTemplate starting with "/" is RELATIVE and gets
// the credential's own base URL prepended before anything is interpolated, so a `{{secret}}` stored
// in that base is sent — the row alone cannot say whether the credential leaves.
export function effectiveUrlTemplate(
  urlTemplate: unknown,
  credentialBaseUrl: string | null | undefined,
): unknown {
  if (typeof urlTemplate !== "string" || !urlTemplate.startsWith("/")) {
    return urlTemplate;
  }
  // No base and a relative template is a tool `buildHttpTool` refuses to build at all; there is no
  // request to say anything about.
  return credentialBaseUrl ? `${credentialBaseUrl}${urlTemplate}` : urlTemplate;
}

export function reachableTemplates(
  method: string | null | undefined,
  shapes: ToolShapePatch,
): string[] {
  const emitted: string[] = [...transmittedUrl(shapes.urlTemplate)];
  emitted.push(
    ...headerTemplates(shapes.headers),
    ...Object.values(reachingQuery(shapes)),
  );
  const m = (method ?? DEFAULT_HTTP_METHOD).toUpperCase();
  if (BODY_METHODS.has(m)) {
    emitted.push(...bodyTemplates(shapes.body, aiFields(shapes.inputSchema)));
  }

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
// The names the URL template interpolates — `pathFields` in the runtime, which excludes them from
// the legacy query derivation because they are already spent on the path.
function urlPlaceholderNames(urlTemplate: unknown): Set<string> {
  return typeof urlTemplate === "string" ? namesIn(urlTemplate) : new Set();
}

function autoInjectionReaches(
  kind: string | null | undefined,
  paramName: string | null | undefined,
  method: string,
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
    // The one header the runtime writes ITSELF: a body method with no content-type of its own gets
    // `Content-Type: application/json` added before auto-injection, which occupies that target the
    // same way an operator's own header does.
    if (
      BODY_METHODS.has(method) &&
      inj.name.toLowerCase() === "content-type" &&
      !names.some((h) => h.toLowerCase() === "content-type")
    ) {
      return false;
    }
    return !names.some((h) => h.toLowerCase() === inj.name.toLowerCase());
  }
  // Query: the runtime injects unless the param is already on the URL — spelled in the template, or
  // set from the explicit query map, which it applies first and only for a value that resolves
  // NON-EMPTY. Whether a value resolves empty is knowable from its literal part alone: `prefix-{{id}}`
  // cannot come out empty whatever `id` is, while a bare `{{id}}` can, and only the first is sure to
  // take the parameter. Guessing that a placeholder always resolves would warn about a tool that is
  // wired.
  const fixed = fixedValuesByName(shapes.inputSchema);
  if (urlQueryKeys(shapes.urlTemplate, fixed).has(inj.name)) return false;
  // The legacy derivation: a NON-body method whose body is the legacy `fields` shape and which has no
  // explicit query copies its non-path input fields into the URL — before auto-injection, and with
  // `v != null` rather than `v !== ""`, so a fixed field of that name takes the parameter whatever it
  // holds. An AI field of that name is not counted: the model may omit it, and that is unknowable.
  if (
    !BODY_METHODS.has(method) &&
    isLegacyFieldsBody(shapes.body) &&
    Object.keys(queryMap(shapes.query)).length === 0 &&
    fixed.has(inj.name) &&
    !urlPlaceholderNames(shapes.urlTemplate).has(inj.name)
  ) {
    return false;
  }
  const explicit = reachingQuery(shapes)[inj.name];
  const alwaysSet = explicit !== undefined && alwaysNonEmpty(explicit, fixed);
  return !alwaysSet;
}

export function credentialReachesRequest(
  kind: string | null | undefined,
  paramName: string | null | undefined,
  method: string | null | undefined,
  shapes: ToolShapePatch,
): boolean {
  if (mentions(reachableTemplates(method, shapes), "secret")) return true;
  return autoInjectionReaches(
    kind,
    paramName,
    (method ?? DEFAULT_HTTP_METHOD).toUpperCase(),
    shapes,
  );
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
  facts: {
    kind: string | null;
    paramName: string | null;
    baseUrl: string | null;
  },
  method: string | null | undefined,
  raw: ToolShapePatch,
): string | null {
  if (isNonInjectableSecret(facts.kind)) return null;
  const { shapes: normalized } = normalizeToolShapes(raw);
  const shapes: ToolShapePatch = {
    ...normalized,
    urlTemplate: effectiveUrlTemplate(normalized.urlTemplate, facts.baseUrl) as
      | string
      | undefined,
  };
  if (credentialReachesRequest(facts.kind, facts.paramName, method, shapes)) {
    return null;
  }
  const kind = facts.kind ?? "generic";
  return `the attached credential is never sent: a "${kind}" credential puts nothing on this request by itself, and {{secret}} appears in none of the templates this ${(method ?? DEFAULT_HTTP_METHOD).toUpperCase()} actually emits — it goes out unauthenticated, and the upstream's 401/403 will look like a bad credential rather than one that was never wired. Write {{secret}} where the API expects it, or attach a credential whose type injects it (${INJECTING_MECHANISM_KIND_IDS.join(", ")}) into a header or query parameter the templates do not already set.`;
}
