// What a tool call may leave in `ExecutionLog.detail`, a column documented (docs/logs.md) as never
// carrying message text or PII. Every argument and result value becomes its SHAPE, for every tool
// (a per-tool allowlist would leave privacy to each tool's author and fail open until they decide):
//   { cpf: "12345678900", limit: 5, filtro: { status: "pago" } }
//     → { cpf: "string(11)", limit: "number", filtro: { status: "string(4)" } }
// KEYS are named only at the top level of a tool's arguments, matched against the parameters the
// tool declared: elsewhere a key may be model-chosen (a `z.record` parameter, a tool result), and
// one that merely looks like a field name proves nothing.

const UNNAMED_KEYS = "[unnamed keys]";

// The declared parameter names of a tool, or null when they are unknown (an unregistered tool, a
// schema that is not an object). Only these are ever named.
export type DeclaredKeys = ReadonlySet<string> | null;

export function describeShape(
  value: unknown,
  declared: DeclaredKeys = null,
): unknown {
  if (value === null) return "null";
  if (typeof value === "string") return `string(${value.length})`;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "undefined") return "undefined";
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // NOTE: `declared` is only ever supplied for the top level of an arguments object, so nesting
    // stops here: a nested object reports how many keys it had, and none of their names.
    if (declared === null) return `object(${entries.length} keys)`;
    const out: Record<string, unknown> = {};
    let unnamed = 0;
    for (const [k, v] of entries) {
      if (!declared.has(k)) {
        unnamed += 1;
        continue;
      }
      out[k] = describeShape(v);
    }
    if (unnamed > 0) out[UNNAMED_KEYS] = unnamed;
    return out;
  }
  // NOTE: functions and symbols cannot come out of a JSON tool payload; naming the type is still
  // better than dropping the key silently if one ever does.
  return typeof value;
}
