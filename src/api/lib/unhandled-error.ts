import {
  ElysiaCustomStatusResponse,
  InvalidCookieSignature,
  InvalidFileType,
  ParseError,
  ValidationError,
} from "elysia";

// What the app is allowed to say when a request fails in a way nobody planned for.
//
// The policy is stated by EXCLUSION and keyed on the thrown value's IDENTITY: a value that IS one of
// Elysia's own refusals keeps the answer Elysia gives it, and everything else is an unhandled failure
// whose text never reaches the client outside development.
//
// Both halves of that sentence were learned the hard way (issue #263), and they are the same lesson
// twice. The handler first redacted one named `code`, then two; both lists were short by construction,
// because Elysia hands the handler the `code` PROPERTY of the thrown value when it has one, and every
// library stamps its own — a Prisma `P2025` and a Node `EACCES` walked straight past a two-name list.
// Widening to "any code we do not recognise" fixed the string case and left the numeric one: a
// `DOMException` arrives as code `25` and a plain `Object.assign(new Error(…), { code: 23 })` as `23`,
// neither of which is the `ElysiaCustomStatusResponse` a numeric code was assumed to mean. Both leaked.
//
// `code` is data the thrown value controls, so no rule written over it can be closed. Identity is not:
// `instanceof` answers what the value IS, and nothing a library sets on an error can change it.
//
// NOTE: these must be imported as ESM, not `require`d. Measured: a `require("elysia")` inside this
// module resolves a SECOND instance of the package, against which every `instanceof` is false — a
// fail-open policy that still passes any test asserting only the redacted cases.
export function isFrameworkRefusal(error: unknown): boolean {
  return (
    error instanceof ParseError ||
    // NOTE: since #255 a ValidationError is answered by its own branch in src/app.ts, upstream of
    // the arm that consults this, so today it does not reach here. Listed anyway: this predicate
    // enumerates Elysia's refusal types, not the subset the app currently routes past it, and the
    // day that branch moves or narrows, a schema refusal that fell through would be answered as a
    // blank 500 instead of 422. Measured on the post-#255 tree: a schema-refused body answers 422
    // with the app's own sentence, and dropping this clause still fails the table test below.
    error instanceof ValidationError ||
    error instanceof InvalidCookieSignature ||
    error instanceof InvalidFileType ||
    // A status the handler CHOSE (`status(418, …)`), not a failure. Turning one into a 500 would
    // break a deliberate answer.
    error instanceof ElysiaCustomStatusResponse
  );
}

// The development-only detail. `error` is typed as `Error` at the call site but is not one at runtime
// whenever a handler throws a primitive: `throw "boom"` reaches here as the string itself, and reading
// `.stack ?? .message` off it yields undefined for both, so the response body became the literal
// "undefined" — a debugging aid that hid the one thing being debugged.
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
