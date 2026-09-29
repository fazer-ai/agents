import type { ZodType } from "zod";
import { AppError } from "@/lib/errors";

// Parse what a CALLER sent, and refuse it as the caller's fault. The one place a zod refusal becomes
// an HTTP status: a `ZodError` alone cannot tell a bad caller value from, say, a remote MCP server's
// malformed result, so a global "ZodError means 422" would blame the operator for the latter.

// Only the issue's path crosses to the wire (`windows.0.day`): never zod's message, which quotes the
// caller's own key for `unrecognized_keys`, nor the value (same rule as api/lib/schema-refusal.ts).
// A path segment is a server-chosen name only while no zod record constrains its value type, which
// tests/api/v1/write-body-required.test.ts checks.

// `at` is REQUIRED whenever the value is not the whole payload: zod's path is relative, so parsing
// `params.variants` reports `0.weight` and a lone token reports nothing, a name no input answers to.
export function parseInput<T>(
  schema: ZodType<T>,
  value: unknown,
  at?: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const path = first?.path.map(String).join(".") ?? "";
  const field = [at, path].filter(Boolean).join(".");
  // NOTE: built HERE rather than in a subclass of AppError, so the message, key, interpolation and
  // field sit at one call site that tests/api/lib/refusal-callsites.test.ts and
  // tests/api/error-catalog.test.ts can read; a class choosing its key with a ternary hides it.
  throw field
    ? new AppError(
        `The value sent in ${field} is not valid.`,
        422,
        "errors.invalidRequestValue",
        { field },
        field,
      )
    : new AppError("The request is not valid.", 422, "errors.invalidRequest");
}
