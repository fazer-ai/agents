import type { ApiErrorPayload } from "@/client/lib/types";

// WHERE A REFUSAL GOES, decided once instead of at every call site.
//
// Since #231 the API answers a refusal as `{ error, field? }`: the sentence, localized for whoever is
// reading, and — when the refusal is about one input — the server's own name for that input, which
// reads the same in every language (see src/api/lib/refusal.ts). Measured before this module existed,
// the console read `field` in zero of the thirteen places that already destructure that body.
//
// The decision is small and it is the whole mechanism, so it lives here as a pure function rather
// than inside a hook: a component cannot be asked what it would have done, and this is a rule about
// what the operator ends up seeing.
export interface Refusal {
  message: string;
  // Absent, never empty: the wire omits the key entirely when the refusal is not about one input,
  // and a blank name would be a second spelling of "nothing here" for every reader to handle.
  field?: string;
}

// The backend's own refusal for a failed call, when it sent one.
//
// Eden rejects with an object carrying the parsed body on `value`. Returns null for a transport
// failure (no body, or a body without `error`), where there is nothing the server said.
export function readRefusal(e: unknown): Refusal | null {
  if (!e || typeof e !== "object" || !("value" in e)) return null;
  const value = (e as { value?: ApiErrorPayload }).value;
  const message = value?.error;
  if (typeof message !== "string" || !message.trim()) return null;
  const field = typeof value?.field === "string" ? value.field.trim() : "";
  return field ? { message, field } : { message };
}

// The two channels a refusal can reach the operator through, as an EITHER: exactly one of them
// fires, always.
//
// Both halves of that are load-bearing. Silence is what a mechanism like this breaks first — a form
// that holds every refusal at an input holds the ones it has no input for as well, and the operator
// gets a save button that does nothing. And a message rendered at the control AND repeated in a
// toast is the noise that trains people to dismiss toasts without reading them.
//
// `value` travels with a placement because the mark expires by VALUE and not by a call: `at` shows
// it only while the input still holds what was refused (see the hook).
export type RefusalPlacement =
  | { at: string; message: string; value: unknown }
  | { at?: undefined; toast: string };

// What the form was doing when the answer landed. The first round of review on #313 found three ways
// a placement can be held and never read, and they are all this: the question is not "is this input
// one the form declared" but "will the operator actually read this".
export interface FormAtAnswer {
  // False once the form is gone. A modal body can unmount while its own save is in flight — this
  // card's own comments record that the operator does exactly that — and a mark written to state
  // nobody renders is silence, with `capture` having already reported "it is on the control".
  mounted: boolean;
  // What the request carried. A refusal is about the value that was SENT.
  sent: Record<string, unknown>;
  // What the inputs hold now. If they no longer hold what was sent, the operator changed it while
  // the request was out, and marking the box would put "this is not valid" under a value the server
  // never saw.
  current: Record<string, unknown>;
}

// `rendered` is what the FORM declares it can show, by the server's names.
//
// Declared and not discovered, because of WHEN the answer is needed: the submit handler has to know,
// before React renders again, whether it must raise a toast. A registry that filled itself while
// rendering would answer for the previous render — the one before the refusal existed.
//
// Matched exactly, never by prefix. The server's names are dotted paths into bags it owns
// (`guardrails.output.templateMessage`), and a form that wants to catch a subtree can say so by
// listing what it renders. Guessing that a form showing `guardrails` also shows every leaf under it
// is how a refusal ends up marked on a control that is not about it.
export function placeRefusal(
  refusal: Refusal | null,
  rendered: readonly string[],
  fallback: string,
  form: FormAtAnswer,
): RefusalPlacement {
  if (!refusal) return { toast: fallback };
  const { field, message } = refusal;
  if (!field || !rendered.includes(field)) return { toast: message };
  if (!form.mounted) return { toast: message };
  // Only when the request carried this field. A refusal about a value this write did not change is
  // about what is stored, and the input has not moved relative to it, so there is nothing stale.
  const carried = Object.hasOwn(form.sent, field);
  if (carried && form.sent[field] !== form.current[field]) {
    return { toast: message };
  }
  return { at: field, message, value: form.current[field] };
}
