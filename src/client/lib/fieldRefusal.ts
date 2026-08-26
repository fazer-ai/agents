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
//
// With ONE exception, and it is not a prefix rule: a trailing NUMERIC segment is an element of the
// declared list, not a different value. The schema boundary refuses arrays per element and says so —
// measured on this tree: `redirectUris.0`, `windows.0`, `accountIds.0`, `grants.0` — while the form
// renders the whole list through one control. Exact matching alone means every array input in the
// console can never receive its own refusal. A named segment stays unmatched, because `guardrails`
// and `guardrails.output` are two different values and only the form knows which one it draws.
export function placeRefusal(
  refusal: Refusal | null,
  rendered: readonly string[],
  fallback: string,
  form: FormAtAnswer,
): RefusalPlacement {
  if (!refusal) return { toast: fallback };
  const { field, message } = refusal;
  if (!field) return { toast: message };
  const declared = rendered.includes(field)
    ? field
    : rendered.find((name) =>
        new RegExp(`^${escapeName(name)}\\.\\d+$`).test(field),
      );
  if (declared === undefined) return { toast: message };
  if (!form.mounted) return { toast: message };
  // Only when the request carried this field. A refusal about a value this write did not change is
  // about what is stored, and the input has not moved relative to it, so there is nothing stale.
  const carried = Object.hasOwn(form.sent, declared);
  if (carried && !sameValue(form.sent[declared], form.current[declared])) {
    return { toast: message };
  }
  return { at: declared, message, value: form.current[declared] };
}

// "The box still holds what the server was talking about", for a value of any shape.
//
// Reference identity is wrong for everything that is not a primitive, and wrong in the direction that
// SILENCES the mechanism: a form rebuilds its request body on every render, so an array or an object
// read twice is two values that are never `===`. Every such field would read as edited-during-the-
// request and be sent to the toast — measured the moment the first list control was wired, and
// invisible before it because the six fields of the reference card are all strings.
//
// Structural rather than deep-equal by hand: these values are request bodies, so they are JSON by
// construction, and a shape that cannot be serialised is one this comparison should not claim to
// answer for. It falls back to identity there rather than throwing inside a submit handler.
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// A declared name inside a regex. The names are the server's own — columns and dotted paths — so the
// dot is the only metacharacter any of them carries today, and escaping the set rather than the one
// character is what keeps that true of the next name too.
function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
