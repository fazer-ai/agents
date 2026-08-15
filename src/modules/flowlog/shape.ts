// What a tool call is allowed to leave behind in `ExecutionLog.detail`.
//
// That column is documented (docs/logs.md) as allowlisted ids/counts/enums that NEVER carry message
// text or PII, and it is exportable through `GET /v1/logs`. Tool arguments are the opposite of an
// allowlist: they are whatever the model decided to send, shaped by a tool schema an operator wrote.
// A tool that takes a document number, an address or a full name therefore wrote exactly that into a
// column promising none of it, and `redactSecretsDeep` could not help — it keys off credential-shaped
// NAMES (`api_key`, `token`), not off a value that is sensitive by content (issue #78).
//
// The rule here replaces the value with its SHAPE, and keeps nothing else:
//
//   { cpf: "12345678900", limit: 5, filtro: { status: "pago" } }
//     → { cpf: "string(11)", limit: "number", filtro: { status: "string(4)" } }
//
// What survives is what makes a log line diagnosable without being able to identify anyone: which
// arguments the model chose to send, which it omitted, whether a string arrived empty, whether an
// array came back with zero elements, whether a nested object has the expected keys. What is gone is
// every value the model wrote. This is deliberately the same rule for every tool, because the
// alternative — a per-tool allowlist of loggable arguments — puts the privacy decision on whoever
// authors the tool and fails open until they make it.
//
// It also replaces two narrower mechanisms that came before it: URLs collapsed to a marker and a
// `caption` key dropped by name. Both were special cases of "the value is model-written text", and a
// shape covers them without an ever-growing list of key names to remember.
//
// KEYS are named only where their provenance is KNOWN: the top level of a tool's arguments, matched
// against the parameter names that tool actually declared. Nothing else is named.
//
// The obvious shortcut — keeping keys that LOOK like schema fields — does not hold. `{ Maria: … }`
// and a UUID starting with a letter both look like identifiers, an object parameter typed as a
// free-form record (`z.record(...)`, which is what every HTTP tool with an object parameter uses)
// lets the model choose its keys, and a tool RESULT is authored end to end by whatever answered the
// call. A guarantee that rests on the shape of a string is not a guarantee, so keys are named from
// the declaration or not at all.

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
