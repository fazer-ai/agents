import type { ZodType } from "zod";
import { AppError } from "@/lib/errors";

// Parse what a CALLER sent, and refuse it as the caller's fault.
//
// The one place a zod refusal becomes an HTTP status. Every service that validates a create/update
// payload goes through here instead of calling `schema.parse` itself, because the difference between
// "the caller sent a bad value" and "something else failed to validate" is not visible in a
// `ZodError`: the MCP SDK rejects with one when a remote server answers a malformed result, and a
// global "ZodError means 422" branch in the error handler answered that as the operator's mistake.
//
// The field is the issue's path, spelled the way #245 spells a path on the wire (`windows.0.day`).
// Nothing else from the issue crosses: not zod's message, which quotes the caller's own key for
// `unrecognized_keys`, and never the submitted value — the same rule api/lib/schema-refusal.ts
// follows for the transport's refusal, and for the same reason.
//
// A path segment is a name the SERVER chose only while no zod record in this repo constrains its
// value type (a `z.record(z.string(), z.unknown())` cannot fail below itself), which
// tests/api/v1/write-body-required.test.ts checks rather than leaves as a reading.
// `at` is the caller's name for the value being parsed, and it is REQUIRED whenever the value is not
// the whole payload: zod's path is relative to what was handed to it, so parsing `params.variants`
// reports `0.weight`, and parsing a lone token reports nothing at all. Either one puts a name on the
// wire that no input on the caller's side answers to — the field exists so a client can point at the
// input, and a relative path points at nothing. Found by review on PR #309.
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
  // Built HERE rather than in a subclass of AppError, so the message, the key, the interpolation and
  // the field sit at one call site: tests/api/lib/refusal-callsites.test.ts and the catalog rule in
  // tests/api/error-catalog.test.ts both read the call site, and a class that decides its own key
  // with a ternary is a refusal neither of them can read (the lesson #299 wrote down).
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
