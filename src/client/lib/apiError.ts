import type { ApiErrorPayload } from "@/client/lib/types";

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
export function apiErrorMessage(e: unknown): string | null {
  if (!e || typeof e !== "object" || !("value" in e)) return null;
  const value = (e as { value?: ApiErrorPayload }).value;
  const msg = value?.error;
  return typeof msg === "string" && msg.trim() ? msg : null;
}
