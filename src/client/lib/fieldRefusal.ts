import type { ApiErrorPayload } from "@/client/lib/types";

// WHERE A REFUSAL GOES, decided once instead of at every call site. The API answers a refusal as
// `{ error, field? }`: the sentence, localized for the reader, and, when it is about one input, the
// server's own name for that input, the same in every language (src/api/lib/refusal.ts). A pure
// function rather than a hook, because this is a rule about what the operator ends up seeing, and a
// component cannot be asked what it would have done. See docs/ui.md, "Where a server refusal goes".
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

// The channels a refusal can reach the operator through; the operator is told exactly once:
//   1. `{ at }`          the control is on screen. The mark is the message; nothing else fires.
//   2. `{ at, toast }`   the form OWNS the control and is not drawing it (another tab). The mark
//                        waits for the operator, and the sentence is said now, since a mark nobody
//                        is looking at is silence; the caller stops announcing once it is on screen.
//   3. `{ toast }`       not this form's input. The sentence is the only channel.
// `value` travels with a placement because the mark expires by VALUE, not by a call (see the hook).
export type RefusalPlacement =
  | { at: string; message: string; value: unknown; toast?: string }
  | { at?: undefined; toast: string };

// What the form was doing when the answer landed. The question is not "is this input one the form
// declared" but "will the operator actually read this".
export interface FormAtAnswer {
  // False once the form is GONE FROM THE SCREEN, which is not the same as the component being
  // unmounted: a modal body can close while its own save is in flight and the wrapper stays mounted,
  // so the hook takes the dialog's own `isOpen` as well. A mark written to state nobody renders is
  // silence, with `capture` having already reported "it is on the control".
  mounted: boolean;
  // What the request carried. A refusal is about the value that was SENT.
  sent: Record<string, unknown>;
  // What the inputs hold now. If they no longer hold what was sent, the operator changed it while
  // the request was out, and marking the box would put "this is not valid" under a value the server
  // never saw.
  current: Record<string, unknown>;
  // Every name this form can place a mark on, drawn or not. Defaults to `rendered`, right for a form
  // whose controls are all on screen together. Separate from `rendered` because that one says whether
  // the mark is READABLE now and this one whether it is worth WRITING at all; a form answering only
  // the second would silence its toast about an input the operator cannot see.
  owned?: readonly string[];
}

// `rendered` is what the FORM declares it can show, by the server's names. Declared, not discovered:
// the submit handler needs the answer before React renders again, and a registry filled while
// rendering would answer for the render before the refusal. Matched exactly, never by prefix, so a
// form showing `guardrails` does not claim every leaf under it. One exception, not a prefix rule: a
// trailing NUMERIC segment is an element of the declared list (`windows.0`, `grants.0`), because the
// schema boundary refuses arrays per element while the form renders the list through one control.
export function placeRefusal(
  refusal: Refusal | null,
  rendered: readonly string[],
  fallback: string,
  form: FormAtAnswer,
): RefusalPlacement {
  if (!refusal) return { toast: fallback };
  const { field, message } = refusal;
  if (!field) return { toast: message };
  const drawn = resolveName(field, rendered);
  // NOTE: `owned` is only consulted for a name `rendered` did not answer, so a form that draws
  // everything it owns never reaches it.
  const declared = drawn ?? resolveName(field, form.owned ?? rendered);
  if (declared === undefined) return { toast: message };
  if (!form.mounted) return { toast: message };
  // Only when the request carried this field. A refusal about a value this write did not change is
  // about what is stored, and the input has not moved relative to it, so there is nothing stale.
  const carried = Object.hasOwn(form.sent, declared);
  if (carried && !sameValue(form.sent[declared], form.current[declared])) {
    return { toast: message };
  }
  const placed = { at: declared, message, value: form.current[declared] };
  // Owned but not drawn: the mark is written for the tab the operator has yet to open, and the
  // sentence goes out now so the save does not fail into silence.
  return drawn === undefined ? { ...placed, toast: message } : placed;
}

// The declared name a refused field belongs to, or undefined.
function resolveName(
  field: string,
  names: readonly string[],
): string | undefined {
  return names.includes(field)
    ? field
    : names.find((name) =>
        new RegExp(`^${escapeName(name)}\\.\\d+(?:\\.|$)`).test(field),
      );
}

// "The box still holds what the server was talking about", for a value of any shape. Not reference
// identity: a form rebuilds its request body every render, so an array or object read twice is never
// `===`, and every such field would read as edited mid-request and go to the toast. Structural (JSON)
// rather than a hand-written deep-equal, since request bodies are JSON by construction; a shape that
// cannot be serialised falls back to identity rather than throwing inside a submit handler.
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

// THE TWO RULES A PAGE WITH MORE THAN ONE HOLDER NEEDS, AS FUNCTIONS RATHER THAN AS SHAPE. The agent
// editor keeps one holder per writing form, and these are functions so their behaviour can be
// tested: a guard that reads the page's source stays green when a loop is narrowed to its first entry.

/** What a holder answers for one control: its sentence, or null. */
export type RefusalReader = (field: string, value: unknown) => string | null;

// FIRST match wins. One control draws ONE value, so two holders answering for it would be two
// refusals about the same box, and the older is the one the operator has already been shown. A
// holder whose mark has expired by value is silent here rather than shadowing a live one behind it,
// which is what makes the order safe to fix.
export function firstRefusalAt(
  readers: readonly RefusalReader[],
  field: string,
  value: unknown,
): string | null {
  for (const read of readers) {
    const message = read(field, value);
    if (message) return message;
  }
  return null;
}

// WHOSE VALUE IS THIS, asked of one holder at a time. A refusal does not stay inside the section that
// produced it: a Behavior save refused about `guardrails.output.templateMessage` is answered by
// fixing and saving on the GUARDRAILS tab, while the mark sits in the Behavior holder, so settling
// only the saving form's holder would leave a stale mark on a value the server has since accepted.
// A PLACED refusal is settled by the tab that draws its value, whoever wrote it; one placed nowhere
// is about a SAVE, so its own section answers it.
export function settlesRefusal(args: {
  /** The tab that draws the refused value, or null when the refusal was placed nowhere. */
  drawnBy: string | null;
  /** The section whose holder is being visited. */
  owner: string;
  /** The section that just saved or discarded. */
  settled: string;
}): boolean {
  return args.drawnBy !== null
    ? args.drawnBy === args.settled
    : args.owner === args.settled;
}
