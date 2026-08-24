// Shared application error classes (no imports → no cycles). The Elysia `onError`
// handler maps `AppError.statusCode` before its generic logging branch.

export class AppError extends Error {
  readonly statusCode: number;
  // NOTE: optional i18n key. When set, `onError` translates it (per the request's
  // Accept-Language) before sending the body, with `message` as the English fallback.
  // Without it, the raw `message` reaches the client (fine for protocol/internal errors
  // like OAuth `invalid_grant`, wrong for user-facing flows — set a key there).
  readonly translationKey?: string;
  // NOTE: interpolation values for translationKey ({{placeholders}} in the locale entry).
  // `message` must arrive pre-interpolated: it is the log line and the untranslated fallback.
  readonly translationParams?: Record<string, string | number>;
  // NOTE: optional. The value this refusal is ABOUT, by the name the SERVER uses for it: a column
  // (`systemPrompt`), a key of a patch (`document`), or a dotted path into a bag the server owns
  // (`guardrails.output.templateMessage`). Never a form path and never localized: it is a key the
  // client keys on, and it must read the same in every language the sentence is written in.
  //
  // It is the server's vocabulary and not the caller's on purpose. The same service function is
  // reached by REST and by MCP, which spell the same write differently, so a name taken from the
  // request shape would be a different string depending on who called, and the console already
  // maps these exact paths (TEXT_CAP_TARGETS, src/client/lib/configHealth.ts), which is the map a
  // refusal wants to reuse. Absent whenever the refusal is not about one input: see
  // src/api/lib/refusal.ts for what the wire then carries. Issue #231.
  readonly field?: string;
  constructor(
    message: string,
    statusCode: number,
    translationKey?: string,
    translationParams?: Record<string, string | number>,
    field?: string,
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.translationKey = translationKey;
    this.translationParams = translationParams;
    this.field = field;
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", translationKey?: string) {
    super(message, 403, translationKey);
  }
}

// NOTE: raised when a Pro-only mutation is reached in the Free edition. 403 with a user-facing i18n
// key so the client can surface an upgrade prompt. Thrown by the Free-edition paired stubs that stand
// in for Pro-only write modules (e.g. the tenants/branding admin services). Kept here (not in
// edition.ts) so this module stays import-cycle-free.
export class ProEditionError extends AppError {
  constructor(message = "This feature requires the Pro edition") {
    super(message, 403, "errors.proEdition");
  }
}

// NOTE: a uniqueness/state conflict surfaced to the user (e.g. a duplicate tenant slug).
export class ConflictError extends AppError {
  constructor(message = "Conflict", translationKey?: string) {
    super(message, 409, translationKey);
  }
}

// NOTE: a tenant-scoped operation was attempted without a resolved target tenant
// (e.g. a SUPER_ADMIN call missing the X-Tenant-Id selector). 400, not 500.
export class TenantTargetRequiredError extends AppError {
  constructor(message = "A target tenant is required for this operation") {
    super(message, 400);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", translationKey?: string) {
    super(message, 404, translationKey);
  }
}

// NOTE: uniform 401 for the inbound receptor. An unknown/disabled route token and a bad
// auth signature must look identical (same status, same body) so the response never reveals
// which token strings are live.
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
  }
}

// NOTE: a transient infrastructure failure surfaced while verifying the session (e.g. the
// DB pool reconnecting during a dev hot-reload, a brief outage). 503 tells the client to
// retry instead of treating the request as a logout — a null user from a swallowed DB error
// is indistinguishable from a real "no session" and would bounce the operator to /login on
// every server blip. No translationKey: the body is never user-facing (the client retries).
export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable") {
    super(message, 503);
  }
}
