import { AsyncLocalStorage } from "node:async_hooks";

// What the code running now is, in a few words an operator recognizes: `job:FOLLOWUP_SWEEP` for a
// scheduler job, `GET /v1/conversations/:id` for a request. Read where a statement fails, so the
// timeout it records (and the alert about it) names the work and not only the SQL (docs/logs.md,
// "Database"). Set where the work enters, never by the statement.
const current = new AsyncLocalStorage<string>();

// A scheduler job, or any unit of work with a clear start and end.
export function runWithWorkLabel<T>(label: string, fn: () => T): T {
  return current.run(label, fn);
}

// For a request, set by a lifecycle hook once the route is matched: Elysia gives no wrapper around
// the handler, so this enters the label for the rest of that request's continuation, the same way the
// request's locale is entered (src/api/middlewares/locale.ts).
export function enterWorkLabel(label: string): void {
  current.enterWith(label);
}

export function currentWorkLabel(): string | null {
  return current.getStore() ?? null;
}
