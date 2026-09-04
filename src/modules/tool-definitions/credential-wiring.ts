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
import {
  CONTEXT_VAR_NAMES,
  normalizeToolShapes,
  type ToolShapePatch,
} from "./normalize";
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

// TWO sentinels for an unresolved placeholder, and the pair is the mechanism. A query KEY may be a
// placeholder, and the key it becomes at runtime is unknowable here; a single sentinel puts a made-up
// key into a space where a real one could equal it, and then answers "that parameter is taken" for a
// tool where it is not. Both spellings have already cost a round: `_` collided with a legal param
// name, `((unresolved))` with a legal query-map key.
//
// Parsing the same template under both and INTERSECTING the key sets needs no such assumption. A
// literal key parses identically twice and survives; a placeholder-derived one differs and drops out
// — including a literal key that happens to equal one of the sentinels, which still parses the same
// both times.
const UNRESOLVED_A = "((unresolved-a))";
const UNRESOLVED_B = "((unresolved-b))";

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
// The declared types whose value can never stringify to the empty string: zod gives a number, an
// integer or a boolean, and `String()` of any of them is at least one character. A `string` field
// can be `""`, and an enum is only sure when every one of its values is non-empty.
//
// A required `string` is the case this cannot answer, and it is deliberately on the quiet side:
// `zodFor` builds a bare `z.string()` with no `.min(1)`, so the model may send `""` and the runtime
// then SKIPS that query entry and injects the credential after all. Whether the credential is sent
// depends on what the model typed, so no executed row can assert it either way — the same shape as
// the multi-value enum above.
function neverEmptyByType(spec: Record<string, unknown>): boolean {
  if (spec.type === "integer" || spec.type === "number") return true;
  if (spec.type === "boolean") return true;
  if (spec.type === "enum") {
    const values = spec.enumValues;
    return (
      Array.isArray(values) &&
      values.length > 0 &&
      values.every((v) => typeof v === "string" && v !== "")
    );
  }
  return false;
}

// The REQUIRED ai fields the runtime is sure to receive a non-empty value for. Required is the first
// half — zod refuses the call without it — and the type is the second: a required `string` may still
// arrive empty, and an empty query value is one the runtime skips.
function alwaysFilledAiNames(schema: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof schema !== "object" || schema === null) return out;
  for (const [name, spec] of Object.entries(schema)) {
    if (!isPlainObject(spec) || spec.source === "fixed") continue;
    if (!spec.required) continue;
    if (neverEmptyByType(spec)) out.add(name);
  }
  return out;
}

function alwaysNonEmpty(
  template: string,
  fixed: Map<string, string>,
  resolveFixed = true,
  ackArg = false,
  alwaysFilled: Set<string> = new Set(),
): boolean {
  if (template.replace(PLACEHOLDER, "") !== "") return true;
  if (ackArg && namesIn(template).has(WAIT_MESSAGE_ARG)) return true;
  for (const name of namesIn(template)) if (alwaysFilled.has(name)) return true;
  // ABOVE the recursion guard, not inside the loop below it: a prototype name resolves to a
  // stringified Object member at ANY depth, so a fixed value of `{{toString}}` is non-empty when it
  // is followed as well as when it is read directly.
  for (const name of namesIn(template)) if (name in {}) return true;
  if (!resolveFixed) return false;
  for (const name of namesIn(template)) {
    // The prototype names are non-empty for a DIFFERENT reason than the fixed ones, and the two
    // questions this file asks about them have opposite answers. WHICH key the URL ends up with is
    // unknowable (it is not the operator's value — see `fixedSubstitution`); whether the value can
    // come out EMPTY is not: `String(Object.prototype.toString)` and friends are long strings, so a
    // query value of `{{toString}}` always takes its parameter and always blocks the injection.
    if (name in {}) return true;
    const value = fixedSubstitution(name, fixed);
    if (value !== undefined && alwaysNonEmpty(value, fixed, false)) return true;
  }
  return false;
}

function fixedValuesByName(schema: unknown): Map<string, string> {
  return new Map(fixedFields(schema).map((f) => [f.name, f.value]));
}

// The values that are KNOWN whatever the model does: the operator's fixed fields, plus a required ai
// field whose enum holds exactly one value — zod accepts nothing else, so every executable call
// carries it. Used where the substituted text is what matters (which query key the URL ends up with),
// never where the question is only whether something is non-empty.
//
// EXACTLY ONE, and the mutation that widens it to any enum is one the fence cannot judge: with two
// or more values the key depends on what the model picked, so the executor's answer differs between
// invocations and no single row can assert it. Unknowable falls to the quiet side, like every other
// unknown here.
function knownValuesByName(schema: unknown): Map<string, string> {
  const out = fixedValuesByName(schema);
  if (typeof schema !== "object" || schema === null) return out;
  for (const [name, spec] of Object.entries(schema)) {
    if (!isPlainObject(spec) || spec.source === "fixed") continue;
    if (!spec.required) continue;
    // `zodFor` reads `enumValues` only for `type: "enum"`; on a string field it is decoration and
    // the model may send anything, so the key stays unknowable.
    if (spec.type !== "enum") continue;
    const values = spec.enumValues;
    if (Array.isArray(values) && values.length === 1) {
      const only = values[0];
      if (typeof only === "string") out.set(name, only);
    }
  }
  return out;
}

// The fixed value the runtime would substitute for this placeholder, or undefined when it would not
// substitute one. `valueLookup` asks `n in input` FIRST, and `in` walks the prototype: a field named
// `toString` (or `constructor`, or `valueOf`) resolves to Object.prototype's member, not to the
// operator's fixed value, whatever the schema says. Reading the map for those names claimed a URL
// key the request does not carry — and, on a query credential of that name, called it shadowed.
//
// The runtime's `in` is the defect; this is not the place to change it, and treating those names as
// unresolvable is the reading that agrees with what it does today.
function fixedSubstitution(
  name: string,
  fixed: Map<string, string>,
  ackArg = false,
): string | undefined {
  // The ack argument shadows a fixed field of the same name for the same reason a prototype member
  // does: `valueLookup` reads `input` first, and on an ack-enabled tool the model always supplies
  // `__wait_message`. A `{{secret}}` an operator put in a fixed field of that name never leaves.
  if (ackArg && name === WAIT_MESSAGE_ARG) return undefined;
  return name in {} ? undefined : fixed.get(name);
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
// The header entries as the runtime walks them: `Object.entries(headerTemplates)` over whatever is
// in the column, ARRAY included — a stored `headers: ["{{secret}}"]` sends the credential under the
// header named `0`. `isPlainObject` excludes arrays, so reading them through it reported that tool
// as unwired.
function headerEntries(v: unknown): [string, string][] {
  if (typeof v !== "object" || v === null) return [];
  return Object.entries(v)
    .filter(([k]) => k !== SWALLOWED_HEADER)
    .map(([k, x]) => [k, String(x)]);
}

function headerTemplates(v: unknown): string[] {
  return headerEntries(v).map(([, value]) => value);
}

// The query map as the runtime reads it (`parseQuery`): a null/undefined value is dropped and
// everything else is STRINGIFIED, so `{ token: 123 }` is a real, non-empty query value. Reading only
// the strings would call that entry absent and then conclude the credential is auto-injected into a
// parameter the operator has already taken.
function queryMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  // ANY object, arrays included — `parseQuery` guards on `typeof raw === "object"` and nothing else,
  // so a stored `query: ["{{secret}}"]` is the parameter `0`, exactly as a headers array is.
  if (typeof raw !== "object" || raw === null) return out;
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
  unresolved: string = UNRESOLVED_A,
): URL | null {
  if (typeof urlTemplate !== "string") return null;
  const resolved = urlTemplate.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = fixedSubstitution(name, fixed);
    // One level, like everywhere else here: a fixed value that is itself a template resolves from
    // context, which is unknowable, so it stays neutral.
    // ENCODED, because the runtime's interpolation is: `encodeURIComponent(v)` on every substituted
    // value. A fixed key holding a URL metacharacter (`token&x`) is ONE parameter of that name
    // there, and three separate ones here if the substitution goes in raw — which would read the
    // credential's own parameter as already taken and warn about a tool that injects it.
    return value !== undefined && namesIn(value).size === 0
      ? encodeURIComponent(value)
      : unresolved;
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
  const a = parseUrlTemplate(urlTemplate, fixed, UNRESOLVED_A);
  const b = parseUrlTemplate(urlTemplate, fixed, UNRESOLVED_B);
  if (!a || !b) return new Set();
  const other = new Set(b.searchParams.keys());
  return new Set([...a.searchParams.keys()].filter((k) => other.has(k)));
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
    knownValuesByName(shapes.inputSchema),
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
  if (typeof schema !== "object" || schema === null) return { names, optional };
  for (const [name, spec] of Object.entries(schema)) {
    const s = isPlainObject(spec) ? spec : {};
    if (s.source === "fixed") continue;
    names.add(name);
    // TRUTHY, like `parseFields`' own `!!s.required`: the definition schema lets a field spec carry
    // anything, and `required: "yes"` is required there.
    if (!s.required) optional.add(name);
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
      if (!isPlainObject(r)) continue;
      const k = typeof r.key === "string" ? r.key.trim() : "";
      if (!k) continue;
      // COERCED, not skipped: `parseBody` turns a non-string value into `""`, and that row still
      // overwrites the one before it. Skipping it kept a `{{secret}}` the request no longer carries.
      const rowValue = typeof r.value === "string" ? r.value : "";
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
      const lone = rowValue.match(LONE_PLACEHOLDER)?.[1];
      const loneAi = lone !== undefined && ai.names.has(lone);
      const mayBeOmitted = lone !== undefined && ai.optional.has(lone);
      const carried = loneAi ? "" : rowValue;
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
  // ANY object, arrays included: `parseFields` guards on `typeof raw === "object"` like every other
  // reader in the executor, so a legacy row whose schema is an array has fields named 0, 1, 2 —
  // fixed values among them.
  if (typeof schema !== "object" || schema === null) return [];
  const out: { name: string; value: string }[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    // `source === "fixed"` is not a detail: `buildHttpTool` reads `s.source === "fixed" ? "fixed" :
    // "ai"` and precomputes only the fixed values with the secret in scope, so a `{{secret}}` written
    // into an AI field's `value` is never interpolated.
    // A fixed field whose `value` is absent or not a string is still a fixed field — `parseFields`
    // gives it `""` — and its NAME is what the legacy query derivation puts on the URL, blocking a
    // query credential of the same name. Dropping it here lost the name, not just the value.
    if (isPlainObject(spec) && spec.source === "fixed") {
      // `fixedValues[f.name] = …` on a plain `{}` again: a field named `__proto__` reaches the
      // inherited setter and no value is stored, so every reader of that map gets the prototype
      // instead. Same swallow as the header of that name, in the map the executor builds for itself.
      if (name === SWALLOWED_HEADER) continue;
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
export function isRelativeTemplate(urlTemplate: unknown): boolean {
  return typeof urlTemplate === "string" && urlTemplate.startsWith("/");
}

export function effectiveUrlTemplate(
  urlTemplate: unknown,
  credentialBaseUrl: string | null | undefined,
): unknown {
  if (!isRelativeTemplate(urlTemplate)) return urlTemplate;
  // No base and a relative template is a tool `buildHttpTool` REFUSES to build — it throws "relative
  // urlTemplate requires a credential with a base URL" before there is a request at all. Answering
  // `null` here is what lets the caller stay quiet: a warning that the request goes out
  // unauthenticated diagnoses a failure that cannot happen, and points away from the one that does.
  return credentialBaseUrl ? `${credentialBaseUrl}${urlTemplate}` : null;
}

// Whether the runtime can build a request from this template at all. It parses the neutralized
// template with NO base (`new URL(effectiveTemplate.replace(PLACEHOLDER, "_"))`) to pin the origin,
// and throws `invalid urlTemplate` when that fails — so a stored `not-a-url`, which the definition
// schema accepts, is a tool that never reaches a fetch. Same reasoning as the relative-with-no-base
// case above: there is no unauthenticated request to warn about.
function buildsARequest(
  urlTemplate: unknown,
  shapes: ToolShapePatch,
  ackArg: boolean,
  allowedHosts: string[] | null | undefined,
  relative: boolean,
): boolean {
  if (typeof urlTemplate !== "string") return false;
  // The ORIGIN is pinned: `buildHttpTool` takes it from the neutralized template and throws
  // "interpolation altered the origin" when the real one differs, so a placeholder anywhere in the
  // scheme, host or port is a tool that never fetches. The two sentinels answer where it sits — the
  // origins differ only if a placeholder is inside one.
  const a = parseUrlTemplate(urlTemplate, new Map(), UNRESOLVED_A);
  const b = parseUrlTemplate(urlTemplate, new Map(), UNRESOLVED_B);
  if (!a || !b || a.origin !== b.origin) return false;
  // The allowlist, which is checked before the fetch and throws. The origins above being equal is
  // what makes the host literal, so this is a decision and not a guess: a non-empty list that does
  // not name it refuses every call of this tool.
  //
  // ABSOLUTE templates only. A relative one is explicitly EXEMPT when its host is the credential's
  // own base — `buildHttpTool` keeps `isRelative` for exactly that — and by here the two have been
  // joined into one string, so the host looks like any other. Judging it as one would call a working
  // tool unrunnable and silence a real warning.
  if (
    !relative &&
    allowedHosts &&
    allowedHosts.length > 0 &&
    !allowedHosts.includes(a.hostname)
  ) {
    return false;
  }
  try {
    new URL(urlTemplate.replace(PLACEHOLDER, "_"));
  } catch {
    return false;
  }
  // And every URL placeholder has to have SOMEWHERE to come from. `buildHttpTool` collects the ones
  // it could not resolve and throws for any that the model cannot supply — a `{{order_id}}` naming
  // no field at all is one of those, on every call. A declared field or a context variable may still
  // be missing at call time, and that is per-invocation rather than always, so it stays runnable.
  const ai = aiFields(shapes.inputSchema);
  const fixed = fixedValuesByName(shapes.inputSchema);
  for (const name of namesIn(urlTemplate)) {
    if (name === "secret") continue;
    // The ack argument is declared by the RUNTIME, not by the schema, so it is not an orphan on a
    // tool that has an ack — and is one on a tool that does not.
    if (ackArg && name === WAIT_MESSAGE_ARG) continue;
    // A prototype name resolves for the same reason it resolves everywhere else here: `valueLookup`
    // asks `n in input` and finds Object.prototype's member. Undeclared, and still not an orphan.
    if (name in {}) continue;
    if (ai.names.has(name)) continue;
    if ((CONTEXT_VAR_NAMES as readonly string[]).includes(name)) continue;
    const value = fixed.get(name);
    if (value === undefined) return false;
    // A FIXED field brings its own dependencies, and the runtime tracks them: a `path` whose value is
    // `{{missing}}` resolves to "" with `missing` recorded, and the URL guard then throws for the
    // dependency rather than fetching an incomplete segment. So the field existing is not enough —
    // what it needs has to be available too.
    for (const dep of namesIn(value)) {
      if (dep === "secret") continue;
      if (dep in {}) continue;
      if ((CONTEXT_VAR_NAMES as readonly string[]).includes(dep)) continue;
      return false;
    }
  }
  return true;
}

export function reachableTemplates(
  method: string | null | undefined,
  shapes: ToolShapePatch,
  ackArg = false,
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
  const fixedByName = fixedValuesByName(shapes.inputSchema);
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
    // `fixedSubstitution` and not `value`, for the reason it gives: an emitted `{{toString}}`
    // resolves off `input`'s prototype, never off this field, so the `{{secret}}` an operator wrote
    // into a field of that name never leaves. The legacy body is the exception — it reads
    // `fixedValues[f.name]` directly, with no `in` check, so there the value does arrive.
    if (legacy) {
      out.push(value);
    } else if (mentions(emitted, name)) {
      const substituted = fixedSubstitution(name, fixedByName, ackArg);
      if (substituted !== undefined) out.push(substituted);
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

// WHY the credential's own injection does or does not put it on the request, not just whether. The
// three answers are three different things to tell an operator, and collapsing them to a boolean is
// how the warning came to advise someone who had already done what it was advising: a `bearer_token`
// whose `Authorization` header the tool sets itself IS an injecting type, correctly attached, and
// the fix is the header, not the credential.
type InjectionVerdict =
  | { state: "none" }
  | { state: "reaches" }
  | { state: "swallowed"; name: string }
  | {
      state: "shadowed";
      target: "header" | "query";
      name: string;
      by: "tool" | "runtime";
    };

// A header name that CANNOT be set on the request, however it is written. `buildHttpTool` builds its
// header map as a plain `{}`, so `headers["__proto__"] = v` reaches the inherited setter: the
// assignment succeeds, no own property is created, and the header is silently absent. Exactly the
// loss issue #150 fixed for the body payload with `Object.create(null)` — the headers map was not
// given the same treatment, and mirroring that here is what agrees with the runtime as it is.
const SWALLOWED_HEADER = "__proto__";

// The argument `buildHttpTool` adds for itself when the tool has an ack: required, and rejected by
// zod when empty, so it is present and non-empty on every call that runs.
const WAIT_MESSAGE_ARG = "__wait_message";

function autoInjectionVerdict(
  kind: string | null | undefined,
  paramName: string | null | undefined,
  method: string,
  shapes: ToolShapePatch,
  ackArg = false,
): InjectionVerdict {
  // The value is a probe, never a secret: `resolveSecretInjection` only needs a non-empty string to
  // answer WHERE the credential would go.
  const inj = resolveSecretInjection(kind, "probe", paramName);
  if (!inj) return { state: "none" };
  const shadowed = (by: "tool" | "runtime"): InjectionVerdict => ({
    state: "shadowed",
    target: inj.target,
    name: inj.name,
    by,
  });
  if (inj.target === "header") {
    if (inj.name === SWALLOWED_HEADER)
      return { state: "swallowed", name: inj.name };
    const names = headerEntries(shapes.headers).map(([name]) => name);
    // The one header the runtime writes ITSELF: a body method with no content-type of its own gets
    // `Content-Type: application/json` added before auto-injection, which occupies that target the
    // same way an operator's own header does.
    if (
      BODY_METHODS.has(method) &&
      inj.name.toLowerCase() === "content-type" &&
      !names.some((h) => h.toLowerCase() === "content-type")
    ) {
      return shadowed("runtime");
    }
    return names.some((h) => h.toLowerCase() === inj.name.toLowerCase())
      ? shadowed("tool")
      : { state: "reaches" };
  }
  // Query: the runtime injects unless the param is already on the URL — spelled in the template, or
  // set from the explicit query map, which it applies first and only for a value that resolves
  // NON-EMPTY. Whether a value resolves empty is knowable from its literal part alone: `prefix-{{id}}`
  // cannot come out empty whatever `id` is, while a bare `{{id}}` can, and only the first is sure to
  // take the parameter. Guessing that a placeholder always resolves would warn about a tool that is
  // wired.
  const fixed = fixedValuesByName(shapes.inputSchema);
  if (
    urlQueryKeys(shapes.urlTemplate, knownValuesByName(shapes.inputSchema)).has(
      inj.name,
    )
  ) {
    return shadowed("tool");
  }
  // The legacy derivation: a NON-body method whose body is the legacy `fields` shape and which has no
  // explicit query copies its non-path input fields into the URL — before auto-injection, and with
  // `v != null` rather than `v !== ""`, so a field of that name takes the parameter whatever it holds.
  //
  // A fixed field always, and a REQUIRED ai field too: zod refuses the call without it, so it is on
  // the URL of every invocation that runs. An OPTIONAL ai field is the one that stays unknowable.
  const ai = aiFields(shapes.inputSchema);
  const occupies =
    fixed.has(inj.name) ||
    (ai.names.has(inj.name) && !ai.optional.has(inj.name));
  if (
    !BODY_METHODS.has(method) &&
    isLegacyFieldsBody(shapes.body) &&
    Object.keys(queryMap(shapes.query)).length === 0 &&
    occupies &&
    !urlPlaceholderNames(shapes.urlTemplate).has(inj.name)
  ) {
    return shadowed("tool");
  }
  const explicit = reachingQuery(shapes)[inj.name];
  const alwaysSet =
    explicit !== undefined &&
    alwaysNonEmpty(
      explicit,
      fixed,
      true,
      ackArg,
      alwaysFilledAiNames(shapes.inputSchema),
    );
  return alwaysSet ? shadowed("tool") : { state: "reaches" };
}

export function credentialReachesRequest(
  kind: string | null | undefined,
  paramName: string | null | undefined,
  method: string | null | undefined,
  shapes: ToolShapePatch,
): boolean {
  if (mentions(reachableTemplates(method, shapes), "secret")) return true;
  return (
    autoInjectionVerdict(
      kind,
      paramName,
      (method ?? DEFAULT_HTTP_METHOD).toUpperCase(),
      shapes,
    ).state === "reaches"
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
  // The tool's own ack, when it has one. `buildHttpTool` then DECLARES a required, non-empty
  // `__wait_message` argument of its own, so a query value of `{{__wait_message}}` is set on every
  // executable call and takes its parameter — a field that is in no input schema anywhere.
  opts: { ackMessage?: string | null; allowedHosts?: string[] | null } = {},
): string | null {
  if (isNonInjectableSecret(facts.kind)) return null;
  const { shapes: normalized } = normalizeToolShapes(raw);
  const effective = effectiveUrlTemplate(normalized.urlTemplate, facts.baseUrl);
  const ackArg = !!opts.ackMessage;
  if (
    effective === null ||
    !buildsARequest(
      effective,
      normalized,
      ackArg,
      opts.allowedHosts,
      isRelativeTemplate(normalized.urlTemplate),
    )
  ) {
    return null;
  }
  const shapes: ToolShapePatch = {
    ...normalized,
    urlTemplate: effective as string | undefined,
  };
  const m = (method ?? DEFAULT_HTTP_METHOD).toUpperCase();
  if (mentions(reachableTemplates(method, shapes, ackArg), "secret")) {
    return null;
  }
  const verdict = autoInjectionVerdict(
    facts.kind,
    facts.paramName,
    m,
    shapes,
    ackArg,
  );
  if (verdict.state === "reaches") return null;

  const kind = facts.kind ?? "generic";
  const consequence = `it goes out unauthenticated, and the upstream's 401/403 will look like a bad credential rather than one that was never wired`;
  if (verdict.state === "swallowed") {
    return `the attached credential is never sent: a "${kind}" credential injects into the "${verdict.name}" header, and that name cannot be set on a request — the assignment reaches an inherited setter and creates no header at all, silently. Give the credential another param name; nothing about this tool can make that one arrive.`;
  }
  if (verdict.state === "shadowed") {
    // NOTE: a DIFFERENT sentence, and the reason is that the other one's advice is wrong here. This
    // operator picked an injecting type and attached it correctly; what stops it is the value the
    // request already carries at the target, which the runtime deliberately leaves alone. Telling
    // them to "attach a credential whose type injects it" names something they already did.
    const where =
      verdict.target === "header"
        ? `the "${verdict.name}" header`
        : `the "${verdict.name}" query parameter`;
    const who =
      verdict.by === "runtime"
        ? `a request with a body always carries that header, so the credential can never take it`
        : `this tool sets ${where} itself, and the runtime keeps the value you wrote rather than replacing it with the credential`;
    return `the attached credential is never sent: a "${kind}" credential injects into ${where}, and ${who} — ${consequence}. Write {{secret}} into that value, point the credential at another ${verdict.target === "header" ? "header" : "parameter"}, or remove the one the tool sets.`;
  }
  return `the attached credential is never sent: a "${kind}" credential puts nothing on this request by itself, and {{secret}} appears in none of the templates this ${m} actually emits — ${consequence}. Write {{secret}} where the API expects it, or attach a credential whose type injects it (${INJECTING_MECHANISM_KIND_IDS.join(", ")}) into a header or query parameter the templates do not already set.`;
}
