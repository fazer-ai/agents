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

// The channels a refusal can reach the operator through. THREE outcomes, and the third one is the
// whole of #349.
//
//   1. `{ at }`          the control is on screen. The mark is the message; nothing else fires.
//   2. `{ at, toast }`   the form OWNS the control and is not drawing it. The mark is written for
//                        when the operator gets there, and the sentence still has to be said now,
//                        because a mark on a tab nobody is looking at is silence.
//   3. `{ toast }`       not this form's input. The sentence is the only channel.
//
// It began as an EITHER of two, and that was right while every form drew everything it owned. The
// agent editor does not: it writes about thirty values across eight tabs and draws one tab's worth,
// so "is this name one the form renders" and "is this name one the form can place" stopped being the
// same question. Collapsing them either way loses something real — answer only the first and the
// mark never appears after the operator switches tabs; answer only the second and `capture` reports
// "it is on the control" about a control on another tab, and the save fails into silence.
//
// What did NOT change is the rule underneath: the operator is told exactly once. In case 2 the two
// channels do not overlap, because the caller stops announcing the moment the control is on screen —
// see the editor's banner.
//
// `value` travels with a placement because the mark expires by VALUE and not by a call: `at` shows
// it only while the input still holds what was refused (see the hook).
export type RefusalPlacement =
  | { at: string; message: string; value: unknown; toast?: string }
  | { at?: undefined; toast: string };

// What the form was doing when the answer landed. The first round of review on #313 found three ways
// a placement can be held and never read, and they are all this: the question is not "is this input
// one the form declared" but "will the operator actually read this".
export interface FormAtAnswer {
  // False once the form is GONE FROM THE SCREEN, which is not the same as the component being
  // unmounted. A modal body can close while its own save is in flight — this card's own comments
  // record that the operator does exactly that — and the wrapper around it stays mounted, so the
  // hook takes the dialog's own `isOpen` as well. A mark written to state nobody renders is silence,
  // with `capture` having already reported "it is on the control".
  mounted: boolean;
  // What the request carried. A refusal is about the value that was SENT.
  sent: Record<string, unknown>;
  // What the inputs hold now. If they no longer hold what was sent, the operator changed it while
  // the request was out, and marking the box would put "this is not valid" under a value the server
  // never saw.
  current: Record<string, unknown>;
  // Every name this form can place a mark on, drawn or not. Defaults to `rendered`, which is the
  // right answer for a form whose controls are all on screen together — twenty-three of the
  // twenty-four here.
  //
  // Separate from `rendered` rather than replacing it, because the two answer different questions and
  // the difference is what decides whether the caller must speak: `rendered` says whether the mark is
  // READABLE right now, `owned` says whether it is worth WRITING at all. A form that answered only
  // the second would silence its toast about an input the operator cannot see.
  owned?: readonly string[];
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
  const drawn = resolveName(field, rendered);
  // `owned` is only consulted for a name `rendered` did not answer, so a form that draws everything it
  // owns takes exactly the path it took before this existed.
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

// THE TWO RULES A PAGE WITH MORE THAN ONE HOLDER NEEDS, AS FUNCTIONS RATHER THAN AS SHAPE (#415).
//
// The agent editor keeps one holder per writing form. Both rules below were first written inline in
// the page and guarded by reading its source, and a mutation battery showed what that is worth: a
// loop narrowed to its first entry still contains the text the guard looked for, so the check
// stayed green while the aggregate consulted one holder out of six. Behaviour is what was being
// claimed, so behaviour is what is tested.

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

// WHOSE VALUE IS THIS, asked of one holder at a time.
//
// The half that one-holder-per-form does not get for free, and the reason this is a function with a
// name. The obvious reading is that a form's own save settles its own holder, and it is wrong: a
// refusal does not stay inside the section that produced it. A Behavior save can be refused about
// `guardrails.output.templateMessage`, and the operator answers that by fixing the value on the
// GUARDRAILS tab and saving THERE, while the mark sits in the Behavior holder. Settling only the
// saving form's own holder would leave it standing on a value the server has since accepted, which
// is the stale hold #349 removed.
//
// So a PLACED refusal is settled by the tab that draws its value, whoever wrote it, and one the
// holder could place nowhere is about a SAVE rather than a value, so its own section answers it.
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
