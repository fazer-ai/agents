import { type DocumentDecoration, type TSchema, t } from "elysia";

// Shared OpenAPI documentation helpers (DEV-only docs at /api/docs). They keep per-route annotations
// DRY and consistent across controllers: a standard error-response schema, an `errors(...)` builder
// for the `response` status map, and a `doc(...)` builder for `detail` (summary + description).
//
// SAFETY: declaring only ERROR statuses in `response` does NOT validate the 2xx success path (Elysia
// validates per declared status; an undeclared 200 passes through and is inferred for the spec). The
// app's error handler returns a raw `Response.json({ error })` (see src/app.ts onError), which Elysia
// does not run through response validation either — so these annotations are documentation-only and
// carry no runtime-validation risk.

// The canonical error body every endpoint returns on failure: `{ error: "<message>" }`, plus the
// name of the value the refusal is about when it is about one (see src/api/lib/refusal.ts).
export const ErrorResponse = t.Object(
  {
    error: t.String({ description: "Human-readable error message." }),
    field: t.Optional(
      t.String({
        description:
          "The value the refusal is about, by the server's name for it (a column, a patch key, or a dotted path into a settings bag). Absent when the refusal is not about one input. Never localized.",
      }),
    ),
  },
  { description: "Error response." },
);

// OAuth 2.1 error body (RFC 6749 §5.2): `error` code + optional `error_description`.
export const OAuthErrorResponse = t.Object(
  {
    error: t.String({ description: "OAuth error code (e.g. invalid_grant)." }),
    error_description: t.Optional(t.String()),
  },
  { description: "OAuth 2.1 error response." },
);

const STATUS_DESCRIPTION: Record<number, string> = {
  400: "Bad request — validation failed or the input was malformed.",
  401: "Unauthorized — missing or invalid credentials.",
  403: "Forbidden — authenticated but not allowed (role or tenant gate).",
  404: "Not found.",
  409: "Conflict — a duplicate or a state conflict.",
  410: "Gone — the resource has expired.",
  413: "Payload too large.",
  415: "Unsupported media type.",
  422: "Unprocessable — the input is syntactically valid but semantically rejected.",
  429: "Too many requests — rate limited.",
  502: "Bad gateway — an upstream dependency failed.",
};

// NOTE: The per-status error body shared by `errors(...)` and `errorResponse(...)`, so the two
// builders can never drift apart in the published spec.
function errorSchema(status: number): typeof ErrorResponse {
  return t.Object(
    { error: t.String(), field: t.Optional(t.String()) },
    { description: STATUS_DESCRIPTION[status] ?? "Error." },
  );
}

// Build the `response` status map for the error codes a route can actually return. Each status reuses
// the standard error body with a status-appropriate description.
//
// CRITICAL: the `const` type parameter makes the return type a map of LITERAL numeric keys
// (`{ 400: …; 404: … }`), NOT `Record<number, …>`. A `Record<number>` index signature would tell
// the Eden treaty client that EVERY status (including 200) is the error body, collapsing the success
// `data` type to `{ error: string }` across the whole client. With literal keys, only the declared
// error statuses are constrained and the 2xx success type is still inferred from the handler return.
export function errors<const S extends readonly number[]>(
  ...statuses: S
): { [K in S[number]]: typeof ErrorResponse } {
  const out = {} as { [K in S[number]]: typeof ErrorResponse };
  for (const code of statuses) {
    (out as Record<number, typeof ErrorResponse>)[code] = errorSchema(code);
  }
  return out;
}

// Build a `detail` fragment (summary + optional description) for a route. Tags stay at the instance
// level; the rare per-route tag is set inline (the mixed v1 controller).
export function doc(
  summary: string,
  description?: string,
): { summary: string; description?: string } {
  return description ? { summary, description } : { summary };
}

// NOTE: Doc-only `detail.responses` entries for routes that declare no `response` schema
// (single-status routes: always-200 acks, the HTML OAuth popups, the /v1/mcp 405 stubs). OpenAPI
// requires at least one response per operation, so without these the published spec fails
// validation. Living under `detail` keeps them pure documentation — declaring a `response` schema
// instead would turn on runtime response validation for that status and rewrite the Eden treaty
// success type. The Extract narrows to the inline response-object member (drops the $ref member)
// so callers can extend an entry (e.g. add documented headers) with a spread.
export type ResponseDoc = Extract<
  NonNullable<DocumentDecoration["responses"]>[string],
  { description: string }
>;

export function jsonResponse(
  description: string,
  schema?: TSchema,
): ResponseDoc {
  return {
    description,
    ...(schema ? { content: { "application/json": { schema } } } : {}),
  };
}

// NOTE: The OAuth popup callbacks: every status carries HTML (the page postMessages the result to
// its opener and self-closes), so the standard JSON error map does not apply.
export function htmlResponse(description: string): ResponseDoc {
  return {
    description,
    content: { "text/html": { schema: t.String() } },
  };
}

// NOTE: Doc-only twin of one `errors(...)` entry, for routes that must document BOTH a success and
// error statuses inside `detail.responses` (the openapi plugin replaces `responses` wholesale when
// a `response` schema is present, so mixing `response: errors(...)` with a `detail` 200 drops the
// 200). Reuses `errorSchema` so the published spec stays byte-uniform with `errors(...)`.
export function errorResponse(status: number): ResponseDoc {
  const schema = errorSchema(status);
  return {
    description: schema.description ?? "Error.",
    content: { "application/json": { schema } },
  };
}
