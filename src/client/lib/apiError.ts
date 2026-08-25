import { readRefusal } from "@/client/lib/fieldRefusal";

// The backend's own message for a failed call, when it sent one.
//
// Eden rejects with an object carrying the parsed body on `value`, and every AppError body is
// `{ error }` already localized per the request's Accept-Language. A save that fails a server-side
// CHECK (the system-prompt cap, the settings text caps) is only actionable if the operator reads
// which field and which limit — the generic "could not save" toast tells them nothing they can act
// on, and the field that explains it may be on a tab they are not looking at.
//
// Returns null for a transport failure (no body, or a body without `error`), where the generic toast
// is the honest thing to show.
//
// The half of the same body that names the refused INPUT is read by `readRefusal`, and this delegates
// to it rather than parsing the body a second time: two readers of one wire shape is how the sweep in
// #233 would end up with call sites that show the sentence and call sites that place it, disagreeing
// about what counts as a message at all. Callers that can render a refusal at the control it is about
// want `useFieldRefusal`; this one stays for the actions that are not a form (a delete, a retry, a
// connection test), where a toast is the answer either way.
export function apiErrorMessage(e: unknown): string | null {
  return readRefusal(e)?.message ?? null;
}
