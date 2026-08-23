import { clipText, replaceLoneSurrogates } from "@/lib/text";

// Non-throwing secret redaction for human-facing debug surfaces (the agent playground trace and
// the conversation `lastError` shown to the operator). This is the REPLACE-and-continue cousin of
// n8n-export's `assertNoSecrets`, which THROWS as an export backstop; here we must never break the
// surface, only scrub it. Two layers, same spirit as the export scanner:
//   1. a KEY-name layer — values under credential-named keys are dropped wholesale;
//   2. a VALUE layer — any concrete secret-shaped substring is scrubbed in place.
// By construction the playground trace can never carry a RESOLVED credential (those flow only into
// request headers at fetch time, never into a message), so this is defense-in-depth, not the only
// barrier.

const REDACTED = "‹redacted›";

// High-confidence secret VALUE shapes (global flags: scrub every occurrence, not just the first).
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /(?:bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, // Authorization header material
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style keys
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
];

// Object keys whose VALUE is a credential and must be dropped wholesale.
const SECRET_KEY_RE =
  /(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|authorization|secret|credential)/i;

const MAX_STRING = 2000;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

// Truncates a string to `max` chars, appending a visible marker so a reader knows it was cut.
export function truncate(s: string, max = MAX_STRING): string {
  return s.length > max ? `${clipText(s, max)}…[truncated]` : s;
}

// Scrubs concrete secret-shaped substrings from a string (the VALUE layer). Idempotent.
export function redactSecretsInText(input: string): string {
  let out = input;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

// Recursively copies a value with secrets removed: credential-named keys dropped, secret-shaped
// strings scrubbed, strings truncated, arrays/objects bounded. Non-JSON primitives (functions,
// symbols, bigint) collapse to null/string so the result is always JSON-serializable.
export function redactSecretsDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "‹…›";
  if (value == null) return null;
  if (typeof value === "string") {
    return replaceLoneSurrogates(redactSecretsInText(truncate(value)));
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY)
      .map((v) => redactSecretsDeep(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // NOTE: The KEY gets the same repair as the values. A key is written by whoever produced the
      // object — a model's tool-call arguments, a third party's JSON response — and one orphan half
      // anywhere in the document is enough for Postgres to refuse the whole `jsonb` write.
      out[replaceLoneSurrogates(k)] = SECRET_KEY_RE.test(k)
        ? REDACTED
        : redactSecretsDeep(v, depth + 1);
    }
    return out;
  }
  return null;
}

// A short, safe one-line string for an error surfaced to the operator (conversation lastError):
// the message only, secret-scrubbed and length-bounded — never a stack trace or raw provider body.
export function sanitizeErrorMessage(err: unknown, max = 500): string {
  const raw = err instanceof Error ? err.message : String(err);
  return truncate(redactSecretsInText(raw.replace(/\s+/g, " ").trim()), max);
}
