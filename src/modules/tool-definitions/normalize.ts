// NOTE: normalization of programmatically-authored HTTP tool shapes. The canonical contract (what the
// runtime executes and the UI produces) is a COMPACT input-schema map — {field: {type, required?,
// description?, enumValues?, itemType?}} — and {{var}} placeholders in urlTemplate/query/headers/
// body. API and MCP authors naturally write standard JSON Schema ({properties, required}) and
// OpenAPI-style single-brace {var} path params instead; both used to be accepted verbatim and then
// silently never interpolated. This module converts them to the canonical shape. It is called at
// every write edge (service create/update, MCP tool_create/tool_update preview, agent import) so
// storage stays canonical, at tool build time so rows stored before this normalization existed
// self-heal, and by the editor so legacy rows render their real fields.
// Pure + dependency-free: safe to import from the client bundle.

export interface ToolShapePatch {
  urlTemplate?: string;
  query?: unknown;
  headers?: unknown;
  body?: unknown;
  inputSchema?: unknown;
}

export interface NormalizedToolShapes {
  // Only the keys present in the patch, normalized.
  shapes: ToolShapePatch;
  warnings: string[];
}

// NOTE: conversation/contact context variable names the runtime interpolates (mirror of the
// httpToolContext built in graph/prepare.ts + the conversation_id/message_id merged at buildToolset
// time). Used as the write-time allowlist for single-brace normalization.
export const CONTEXT_VAR_NAMES = [
  "conversation_id",
  "message_id",
  "contact_id",
  "contact_name",
  "contact_email",
  "contact_phone",
  "inbox_id",
  "inbox_name",
  "company_name",
  "agent_name",
] as const;

const JSON_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
]);

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// NOTE: parsed JSON can carry an own "__proto__" key; plain assignment on a fresh {} would invoke
// the inherited setter and silently drop it. Define an own property instead wherever a
// caller-controlled key lands in an output map.
function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// NOTE: a valid compact map has ONLY plain-object values (one FieldSpec per field). Standard JSON Schema
// is recognized by `properties` being a map of plain objects PLUS a structural marker no compact
// map can produce: a string `type`, an array `required`, or every top-level key being a JSON Schema
// keyword. Requiring every `properties` value to be an object protects the pathological compact
// field literally named "properties" ({properties: {type: "object"}} has the string value "object"
// under it, so it stays compact).
export function isJsonSchemaShape(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  const props = raw.properties;
  if (!isPlainObject(props)) return false;
  if (!Object.values(props).every(isPlainObject)) return false;
  return (
    typeof raw.type === "string" ||
    Array.isArray(raw.required) ||
    Object.keys(raw).every((k) => JSON_SCHEMA_KEYWORDS.has(k))
  );
}

// NOTE: JSON Schema → compact map. Flat scalar/enum/array-of-scalar properties convert faithfully;
// anything deeper (nested properties, anyOf/oneOf, explicit type "object") degrades to the generic
// "object" field type. The top-level `required` array marks per-field required flags. `warnings`
// (optional collector) receives notes about lossy conversions.
export function compactFromJsonSchema(
  raw: Record<string, unknown>,
  warnings?: string[],
): Record<string, unknown> {
  const props = raw.properties as Record<string, unknown>;
  const required = new Set(
    Array.isArray(raw.required)
      ? raw.required.filter((v): v is string => typeof v === "string")
      : [],
  );
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(props)) {
    const s = isPlainObject(spec) ? spec : {};
    const field: Record<string, unknown> = {};
    if (Array.isArray(s.enum) && s.enum.length > 0) {
      if (s.enum.every((v) => typeof v === "string")) {
        field.type = "enum";
        field.enumValues = s.enum as string[];
      } else {
        // NOTE: the compact contract only expresses string enums. Degrade a numeric/boolean enum
        // to its base scalar type (wider but never rejects a declared value) instead of silently
        // dropping the values and validating as a free string.
        field.type = s.enum.every((v) => typeof v === "number")
          ? s.enum.every((v) => Number.isInteger(v))
            ? "integer"
            : "number"
          : s.enum.every((v) => typeof v === "boolean")
            ? "boolean"
            : "string";
        warnings?.push(
          `field "${name}": non-string enum values are not expressible in the compact schema; degraded to type "${field.type}" (allowed values are no longer enforced)`,
        );
      }
    } else if (s.type === "array") {
      field.type = "array";
      const items = isPlainObject(s.items) ? s.items : {};
      const scalarItem =
        typeof items.type === "string" && SCALAR_TYPES.has(items.type)
          ? items.type
          : null;
      field.itemType = scalarItem ?? "string";
      if (!scalarItem && items.type !== undefined) {
        warnings?.push(
          `field "${name}": array item type "${String(items.type)}" is not expressible in the compact schema; items validate as "string"`,
        );
      }
    } else if (
      s.type === "object" ||
      isPlainObject(s.properties) ||
      Array.isArray(s.anyOf) ||
      Array.isArray(s.oneOf) ||
      Array.isArray(s.allOf)
    ) {
      field.type = "object";
      // NOTE: a bare {type: "object"} maps faithfully; only a discarded sub-schema is lossy.
      if (
        isPlainObject(s.properties) ||
        Array.isArray(s.anyOf) ||
        Array.isArray(s.oneOf) ||
        Array.isArray(s.allOf)
      ) {
        warnings?.push(
          `field "${name}": nested/union sub-schema is not expressible in the compact schema; degraded to a generic "object" (structural validation lost)`,
        );
      }
    } else {
      field.type =
        typeof s.type === "string" && SCALAR_TYPES.has(s.type)
          ? s.type
          : "string";
    }
    if (typeof s.description === "string" && s.description) {
      field.description = s.description;
    }
    if (required.has(name)) field.required = true;
    setOwn(out, name, field);
  }
  return out;
}

// NOTE: a single-brace {name} that is not part of a {{name}} token. Lookarounds keep {{name}} (and
// the ambiguous {name}} / {{name} halves) untouched, which also makes the rewrite idempotent.
const SINGLE_BRACE = /(?<!\{)\{\s*([a-zA-Z0-9_]+)\s*\}(?!\})/g;

function rewriteSingleBraces(template: string, names: Set<string>): string {
  return template.replace(SINGLE_BRACE, (match, name: string) =>
    names.has(name) ? `{{${name}}}` : match,
  );
}

function collectUnknownTokens(
  template: string,
  names: Set<string>,
  into: Set<string>,
): void {
  for (const m of template.matchAll(SINGLE_BRACE)) {
    const name = m[1] as string;
    if (!names.has(name)) into.add(name);
  }
}

function fieldNames(schema: unknown): string[] {
  return isPlainObject(schema) ? Object.keys(schema) : [];
}

// NOTE: normalizes the shapes present in `patch`. `current` supplies the rest of the row on partial
// updates so the placeholder allowlist sees the effective field set; `extraNames` adds caller-known
// interpolation names (e.g. the runtime's live context keys). Single-brace {name} is rewritten to
// {{name}} ONLY when the name is a declared input field, a context variable or "secret" — an
// unmatched {token} stays literal (it may be legitimate content, e.g. raw JSON) and is reported in
// `warnings` as a probable typo.
export function normalizeToolShapes(
  patch: ToolShapePatch,
  current: ToolShapePatch = {},
  extraNames: Iterable<string> = [],
): NormalizedToolShapes {
  const warnings: string[] = [];
  const shapes: ToolShapePatch = {};

  const rawSchema =
    patch.inputSchema !== undefined ? patch.inputSchema : current.inputSchema;
  let effectiveSchema = rawSchema;
  if (isJsonSchemaShape(rawSchema)) {
    const conversionWarnings: string[] = [];
    effectiveSchema = compactFromJsonSchema(
      rawSchema as Record<string, unknown>,
      conversionWarnings,
    );
    if (patch.inputSchema !== undefined) {
      warnings.push(
        "input_schema was interpreted as standard JSON Schema and converted to the compact field map",
        ...conversionWarnings,
      );
    }
  }
  if (patch.inputSchema !== undefined) {
    // `__proto__` cannot be a parameter name, and the point of dropping it HERE is that it is
    // dropped VISIBLY. A field under that name is stored and shown in the console like any other,
    // and then disappears one layer down: `parseToolInputSchema` builds the zod shape by assigning
    // into an object, so the name hits the prototype setter and the tool advertises no such
    // parameter — and even a null-prototype shape would not save it, because zod's own result
    // object drops the key on parse (measured, both). Silent for an HTTP tool since #457; a code
    // tool would read `input.__proto__` and find the prototype.
    // `Object.hasOwn`, not `in`: every plain object inherits `__proto__` from Object.prototype, and
    // `in` would warn about a schema that never named it.
    if (
      isPlainObject(effectiveSchema) &&
      Object.hasOwn(effectiveSchema, "__proto__")
    ) {
      const kept: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(effectiveSchema)) {
        if (k !== "__proto__") kept[k] = v;
      }
      effectiveSchema = kept;
      warnings.push(
        "input_schema field `__proto__` was dropped: the name is reserved by JavaScript and cannot reach the model",
      );
    }
    shapes.inputSchema = effectiveSchema;
  }

  const names = new Set<string>([
    ...fieldNames(effectiveSchema),
    ...CONTEXT_VAR_NAMES,
    ...extraNames,
    "secret",
  ]);
  const unknown = new Set<string>();

  if (patch.urlTemplate !== undefined) {
    shapes.urlTemplate = rewriteSingleBraces(patch.urlTemplate, names);
    collectUnknownTokens(patch.urlTemplate, names, unknown);
  }

  for (const key of ["query", "headers"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      shapes[key] = value;
      continue;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") {
        setOwn(out, k, rewriteSingleBraces(v, names));
        collectUnknownTokens(v, names, unknown);
      } else {
        setOwn(out, k, v);
      }
    }
    shapes[key] = out;
  }

  if (patch.body !== undefined) {
    shapes.body = patch.body;
    if (isPlainObject(patch.body)) {
      const body = patch.body;
      if (body.mode === "raw" && typeof body.raw === "string") {
        shapes.body = {
          ...body,
          raw: rewriteSingleBraces(body.raw, names),
        };
        collectUnknownTokens(body.raw, names, unknown);
      } else if (body.mode === "kv" && Array.isArray(body.rows)) {
        shapes.body = {
          ...body,
          rows: body.rows.map((row) => {
            if (!isPlainObject(row) || typeof row.value !== "string")
              return row;
            collectUnknownTokens(row.value, names, unknown);
            return { ...row, value: rewriteSingleBraces(row.value, names) };
          }),
        };
      }
    }
  }

  // NOTE: legacy compact fields may carry source:"fixed" values that are templates too.
  if (shapes.inputSchema !== undefined && isPlainObject(shapes.inputSchema)) {
    const schema = shapes.inputSchema;
    let rewritten: Record<string, unknown> | null = null;
    for (const [name, spec] of Object.entries(schema)) {
      if (!isPlainObject(spec) || typeof spec.value !== "string") continue;
      collectUnknownTokens(spec.value, names, unknown);
      const next = rewriteSingleBraces(spec.value, names);
      if (next !== spec.value) {
        rewritten = rewritten ?? { ...schema };
        setOwn(rewritten, name, { ...spec, value: next });
      }
    }
    if (rewritten) shapes.inputSchema = rewritten;
  }

  if (unknown.size > 0) {
    warnings.push(
      `unrecognized single-brace placeholder(s): ${[...unknown]
        .map((n) => `{${n}}`)
        .join(
          ", ",
        )} — single-brace tokens are only interpolated when they match a declared input field, a context variable or "secret"; left as literal text`,
    );
  }

  return { shapes, warnings };
}

// NOTE: read-side convenience for consumers that only care about the input schema (e.g. the
// editor): returns the compact map, converting a JSON-Schema-shaped value when needed.
export function normalizeInputSchemaShape(
  raw: unknown,
): Record<string, unknown> {
  if (isJsonSchemaShape(raw)) {
    return compactFromJsonSchema(raw as Record<string, unknown>);
  }
  return isPlainObject(raw) ? raw : {};
}
