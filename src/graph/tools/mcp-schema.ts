// The declaration an MCP tool's input schema gets in front of the model. Providers refuse shapes a
// server may legitimately declare (Anthropic refuses a root `allOf`/`anyOf`/`oneOf`, OpenAI wants a
// root object), so local `$ref`s are inlined and composition is folded into one object schema, the
// way @langchain/mcp-adapters 1.x did before handing the schema over. Only the declaration changes:
// the call's arguments are still validated against the schema the server listed.

type Schema = Record<string, unknown>;

// Nodes one declaration may build: inlining shared definitions can repeat a subtree exponentially,
// and this runs on the shared event loop for a schema the server controls.
const NODE_BUDGET = 4096;

interface Walk {
  budget: number;
}

function isSchema(v: unknown): v is Schema {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function inlineRefs(schema: Schema, walk: Walk): unknown {
  const defs = {
    ...(isSchema(schema.definitions) ? schema.definitions : {}),
    ...(isSchema(schema.$defs) ? schema.$defs : {}),
  };
  const visit = (node: unknown, seen: Set<string>): unknown => {
    if (Array.isArray(node)) return node.map((n) => visit(n, seen));
    if (!isSchema(node)) return node;
    if (--walk.budget < 0) return { type: "object" };
    const ref = node.$ref;
    if (typeof ref === "string") {
      const name = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)?.[1];
      const target = name === undefined ? undefined : defs[name];
      if (!isSchema(target)) return node;
      if (seen.has(ref)) return { type: "object" };
      const { $ref: _, ...siblings } = node;
      const resolved = visit(target, new Set(seen).add(ref));
      return {
        ...(isSchema(resolved) ? resolved : {}),
        ...(visit(siblings, seen) as Schema),
      };
    }
    const out: Schema = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$defs" || key === "definitions") continue;
      out[key] = visit(value, seen);
    }
    return out;
  };
  return visit(schema, new Set());
}

function unique(values: unknown[]): unknown[] {
  return [...new Set(values)];
}

// Two schemas that both hold: `required` united, `enum`/`const` united into one `enum`, properties
// merged per name, nested objects merged, other arrays concatenated, scalars from `b`.
function mergeSchemas(a: Schema, b: Schema): Schema {
  const out: Schema = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key];
    if (key === "required" && Array.isArray(prev) && Array.isArray(value)) {
      out[key] = unique([...prev, ...value]);
    } else if (key === "const" || key === "enum") {
      const values = [
        ...(Array.isArray(out.enum) ? out.enum : []),
        ...("const" in out ? [out.const] : []),
        ...(key === "const" ? [value] : Array.isArray(value) ? value : []),
      ];
      delete out.const;
      out.enum = unique(values);
    } else if (key === "properties" && isSchema(prev) && isSchema(value)) {
      const props: Schema = { ...prev };
      for (const [name, prop] of Object.entries(value)) {
        const existing = props[name];
        props[name] =
          isSchema(existing) && isSchema(prop)
            ? mergeSchemas(existing, prop)
            : prop;
      }
      out[key] = props;
    } else if (Array.isArray(prev) && Array.isArray(value)) {
      out[key] = [...prev, ...value];
    } else if (isSchema(prev) && isSchema(value)) {
      out[key] = mergeSchemas(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// The properties a conditional may add, from both its `then` and its `else`.
function conditionalShape(thenBranch: unknown, elseBranch: unknown): Schema {
  let out: Schema = {};
  for (const branch of [thenBranch, elseBranch]) {
    if (!isSchema(branch)) continue;
    if (isSchema(branch.properties))
      out = mergeSchemas(out, { properties: branch.properties });
    if (Array.isArray(branch.required))
      out.required = unique([
        ...(Array.isArray(out.required) ? out.required : []),
        ...branch.required,
      ]);
  }
  return out;
}

function isObjectSchema(s: unknown): s is Schema {
  return isSchema(s) && (s.type === "object" || isSchema(s.properties));
}

// `allOf` merged in; `anyOf`/`oneOf` object branches merged, an argument required only when every
// branch requires it; `if`/`then`/`else` reduced to the properties they may add; `not`, `$schema`
// and `unevaluatedProperties` dropped. Applied down through properties, items and
// additionalProperties.
function simplify(node: unknown, walk: Walk): unknown {
  if (!isSchema(node)) return node;
  if (--walk.budget < 0) return { type: "object" };
  const {
    allOf,
    anyOf,
    oneOf,
    not: _not,
    if: cond,
    then: thenBranch,
    else: elseBranch,
    $schema: _schema,
    unevaluatedProperties: _unevaluated,
    ...base
  } = node;
  let out: Schema = { ...base };
  if (cond || thenBranch || elseBranch)
    out = mergeSchemas(out, conditionalShape(thenBranch, elseBranch));
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      if (isSchema(branch) && (branch.then || branch.else))
        out = mergeSchemas(out, conditionalShape(branch.then, branch.else));
      const simplified = simplify(branch, walk);
      if (isSchema(simplified)) out = mergeSchemas(out, simplified);
    }
  }
  const union = anyOf ?? oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const properties: Schema = {};
    const requiredSets: Set<unknown>[] = [];
    for (const branch of union.filter(isObjectSchema)) {
      const simplified = simplify(branch, walk);
      if (!isSchema(simplified)) continue;
      if (isSchema(simplified.properties))
        Object.assign(properties, simplified.properties);
      if (Array.isArray(simplified.required))
        requiredSets.push(new Set(simplified.required));
      if (simplified.type && !out.type) out.type = simplified.type;
    }
    if (Object.keys(properties).length > 0)
      out.properties = {
        ...(isSchema(out.properties) ? out.properties : {}),
        ...properties,
      };
    if (requiredSets.length > 0) {
      const common = [...(requiredSets[0] ?? [])].filter((name) =>
        requiredSets.every((set) => set.has(name)),
      );
      if (common.length > 0)
        out.required = unique([
          ...(Array.isArray(out.required) ? out.required : []),
          ...common,
        ]);
    }
  }
  if (isSchema(out.properties)) {
    if (!out.type) out.type = "object";
    const props: Schema = {};
    for (const [name, prop] of Object.entries(out.properties))
      props[name] = simplify(prop, walk);
    out.properties = props;
  }
  if (Array.isArray(out.items))
    out.items = out.items.map((item) => simplify(item, walk));
  else if (isSchema(out.items)) out.items = simplify(out.items, walk);
  if (isSchema(out.additionalProperties))
    out.additionalProperties = simplify(out.additionalProperties, walk);
  return out;
}

export function declarationSchema(schema: unknown): unknown {
  if (!isSchema(schema)) return schema;
  const walk = { budget: NODE_BUDGET };
  const declared = simplify(inlineRefs(schema, walk), walk);
  if (isSchema(declared) && !declared.properties) declared.properties = {};
  return declared;
}
