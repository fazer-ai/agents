import { readRefusal } from "@/client/lib/fieldRefusal";

// The backend's own message for a failed call, when it sent one: every AppError body is `{ error }`,
// already localized per Accept-Language, and a failed server-side CHECK (a text cap) is actionable
// only if the operator reads which field and which limit. Null for a transport failure, where the
// generic toast is the honest thing. Delegates to `readRefusal` rather than parsing the body again,
// so one reader decides what counts as a message. A form wants `useFieldRefusal`; this is for the
// actions that are not a form (a delete, a retry, a connection test).
export function apiErrorMessage(e: unknown): string | null {
  return readRefusal(e)?.message ?? null;
}
