import {
  ElysiaCustomStatusResponse,
  InvalidCookieSignature,
  InvalidFileType,
  ParseError,
  ValidationError,
} from "elysia";

// What the app is allowed to say when a request fails in a way nobody planned for. The policy is
// stated by EXCLUSION and keyed on the thrown value's IDENTITY: a value that IS one of Elysia's own
// refusals keeps Elysia's answer; anything else is an unhandled failure whose text never reaches the
// client. Not keyed on `code`: Elysia hands over the thrown value's own `code`,
// which every library stamps (Prisma `P2025`, Node `EACCES`, a DOMException's `25`), so no list
// over it closes. Import these as ESM, never `require`: a `require("elysia")` resolves a SECOND
// instance of the package, against which every `instanceof` is false (fail-open).
export function isFrameworkRefusal(error: unknown): boolean {
  return (
    error instanceof ParseError ||
    // NOTE: src/app.ts answers a ValidationError in its own branch upstream, so it does not reach
    // here today. Listed anyway: this predicate enumerates Elysia's refusal types, and if that
    // branch moves or narrows, a schema refusal falling through would be a blank 500, not a 422.
    error instanceof ValidationError ||
    error instanceof InvalidCookieSignature ||
    error instanceof InvalidFileType ||
    // A status the handler CHOSE (`status(418, …)`), not a failure. Turning one into a 500 would
    // break a deliberate answer.
    error instanceof ElysiaCustomStatusResponse
  );
}
