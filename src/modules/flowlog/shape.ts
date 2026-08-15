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
// KEYS are kept, because they come from the tool's schema rather than from the model — with one
// exception that does not: an object parameter typed as a free-form record (`z.record(...)`) lets the
// model choose the keys too, so a key can carry data. A key is kept only while it LOOKS like a schema
// field (an identifier-ish token); anything else is counted, not named.

const MAX_DEPTH = 4;

// An identifier as a schema would spell it: `cpf`, `due_date`, `orderId`, `X-Custom-Header`. A key
// carrying data ("Maria Souza", "12345678900", a sentence) does not match, and is counted instead.
const SCHEMA_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/;

const UNNAMED_KEYS = "[unnamed keys]";

export function describeShape(value: unknown, depth = 0): unknown {
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
    if (depth >= MAX_DEPTH) return `object(${entries.length} keys)`;
    const out: Record<string, unknown> = {};
    let unnamed = 0;
    for (const [k, v] of entries) {
      if (!SCHEMA_KEY.test(k)) {
        unnamed += 1;
        continue;
      }
      out[k] = describeShape(v, depth + 1);
    }
    if (unnamed > 0) out[UNNAMED_KEYS] = unnamed;
    return out;
  }
  // NOTE: functions and symbols cannot come out of a JSON tool payload; naming the type is still
  // better than dropping the key silently if one ever does.
  return typeof value;
}
