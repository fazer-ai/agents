import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/client/components/Toast";
import {
  placeRefusal,
  readRefusal,
  sameValue,
} from "@/client/lib/fieldRefusal";

// A form's held refusal: which input the server refused, what it said about it, and the value it was
// about.
//
// PER FORM, not per page and not in a context. Two forms are on screen together all the time here — a
// modal over the panel that opened it — and both have a `name`. A shared store would mark the page
// behind the modal, and a store that outlives the form would still be holding a refusal when the
// operator closes a modal and opens it again.
export interface FieldRefusal {
  // The message to render at `field`, or null when this input is not the one refused — or no longer
  // holds the value that was.
  //
  // Keyed by VALUE rather than cleared by a call: an edit takes the mark off because the box stops
  // holding what the server refused, so there is no `onChange` line to forget. Forgetting the
  // argument is a type error; forgetting a `clear(field)` was invisible.
  at: (field: string, value: unknown) => string | null;
  // Take a failed call. Returns the sentence the CALLER must render, or null once the operator has
  // already been told — either because it landed on an input, or because the form was gone and this
  // hook raised the global toast itself. `sent` is what this request carried and `current` is what
  // the inputs hold now — the placement is refused when they disagree about the refused field, or
  // when this form is already gone, because both render the mark unreadable.
  capture: (
    e: unknown,
    fallback: string,
    sent: Record<string, unknown>,
    current: Record<string, unknown>,
  ) => string | null;
  // Drop the mark. Needed for the save that GOES THROUGH: the operator can resubmit the same value
  // after the server changes its mind (a duplicate name freed, a cap raised), and the value key
  // cannot tell that apart from the refusal still standing.
  clear: () => void;
  // The input currently marked, for a caller that has to go somewhere to show it: the agent editor's
  // fields live behind tabs, and a mark on a tab nobody is looking at is not yet visible. Nothing
  // here navigates — which tab holds which path is the screen's knowledge, not this hook's.
  //
  // Null while the standing refusal is about no input of this form's, which `message` still carries.
  field: string | null;
  // The standing refusal's sentence, whether or not it could be placed at an input.
  //
  // Here rather than in the caller because a caller that keeps its own copy has a SECOND source of
  // truth for one fact, and the two drift in ways nothing can see: the copy outlives the mark it
  // duplicates, it is tagged with the wrong owner, a second refusal about the same field leaves the
  // first copy standing. Three review rounds on fazer-ai/agents#414 found three spellings of that,
  // all of them a page holding the sentence beside a hook that was already holding it.
  //
  // Expires with the hold and never on its own: every `capture` overwrites it, and `clear` drops it.
  // A caller rendering it for a PLACED mark still has to ask `at`, because that one expires by value.
  message: string | null;
}

// `rendered` is what the form is DRAWING RIGHT NOW, and the tense is the whole of it.
//
// This started as a constant list plus a boolean for "is the form on screen", and the boolean grew a
// new meaning every review round: a dialog that closed, then a tab that changed. It was always an
// approximation of the question `placeRefusal` actually asks — is THIS name one the operator can see
// — and it is too coarse for a form that hides some of its own controls. Measured, five of those are
// already here: the setup token renders only where enforcement is on, the vault's per-key inputs and
// its base URL disappear when the operator switches to pasting a `.env`, its parameter-name box
// belongs to three of the secret kinds, and the add-content dialog draws the text box on one of its
// two tabs. In every one of them a refusal the server named by that field was marked onto a control
// nobody was rendering, and `capture` told the caller to keep the toast quiet.
//
// So the caller answers with the list, per render, and the boolean is gone: a form that is not on
// screen renders nothing, which is `[]`.
//
// Read through a ref, because the answer is needed AFTER the await and a submit handler closes over
// the render it started in. That was the point of the boolean's ref too; it is the same fix, applied
// to the thing that was always the real question.
// `owned` is every name this form can mark, drawn or not, and it is the second argument because
// almost nobody needs it: a form whose controls are all on screen together owns exactly what it
// renders, and leaving it out says so. The agent editor is the one that does — thirty-odd values
// behind eight tabs — and for it the two lists are genuinely different questions. See placeRefusal.
export function useFieldRefusal(
  rendered: readonly string[],
  owned?: readonly string[],
): FieldRefusal {
  const { showToast } = useToast();
  // `field` is null for a refusal this form cannot place at an input. Held anyway, so the sentence
  // has exactly one home — see `message` above.
  const [held, setHeld] = useState<{
    field: string | null;
    message: string;
    value: unknown;
  } | null>(null);
  // Read from inside a request that may outlive the form. A ref and not state: the answer is needed
  // in a callback that runs after the unmount, where a state read would be the value from the last
  // render this component ever had — which is `true`.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fields = useRef(rendered);
  fields.current = rendered;
  const ownedFields = useRef(owned);
  ownedFields.current = owned;

  const capture = useCallback(
    (
      e: unknown,
      fallback: string,
      sent: Record<string, unknown>,
      current: Record<string, unknown>,
    ) => {
      // The form is where the operator is looking only if it is drawing something. An empty list is
      // a dismissed dialog, a tab left behind, a page unmounted — all the same answer.
      // Drawing NOTHING is what takes the form off the screen, and a form that owns more than it
      // draws is still on screen while the open tab happens to hold no placeable control: the empty
      // list would otherwise read as a dismissed dialog.
      const onForm =
        mounted.current &&
        (fields.current.length > 0 || (ownedFields.current?.length ?? 0) > 0);
      const placed = placeRefusal(readRefusal(e), fields.current, fallback, {
        mounted: onForm,
        sent,
        current,
        owned: ownedFields.current,
      });
      if (placed.at !== undefined) {
        setHeld({
          field: placed.at,
          message: placed.message,
          value: placed.value,
        });
        // Null unless the control is off screen. `placeRefusal` says which by handing back a
        // sentence beside the mark, and the caller is the only one that can put that sentence
        // somewhere the operator will read it AND take them to the control.
        return placed.toast ?? null;
      }
      // NOTE: written even when nothing is placed, and that is the whole of "the capture is also the
      // clear": a mark left over from a refusal the server has stopped making would sit on a control
      // while the toast says something else. The sentence is kept beside the empty field so a caller
      // with a place to render it does not have to hold a copy of its own.
      setHeld(
        placed.toast
          ? { field: null, message: placed.toast, value: undefined }
          : null,
      );
      // The caller's OTHER channel is inside the form for ten of the holders here: an error line
      // drawn between the dialog's title and its buttons, which `useOnModalOpen` then clears on the
      // next opening. Handing them a sentence for a form the operator has dismissed only moves the
      // silence one step over — the mark used to be written where nobody looked, and the sentence
      // would be. So when the form is gone the hook raises the global toast itself.
      //
      // Only for a sentence it HAS. An empty fallback is how a caller says it words this refusal
      // better than the server does (ChannelsPage names the affordance — disconnect first — which
      // the server cannot know about); swallowing its turn would be the new silence.
      if (!onForm && placed.toast) {
        showToast(placed.toast, "error");
        return null;
      }
      return placed.toast;
    },
    [showToast],
  );

  const clear = useCallback(() => setHeld(null), []);

  // By VALUE and not by identity, for the same reason the staleness check is: a form rebuilds its
  // body every render, so a list or an object read twice is never `===` and the mark would never
  // render at all. See sameValue.
  const at = useCallback(
    (field: string, value: unknown) =>
      held?.field === field && sameValue(held.value, value)
        ? held.message
        : null,
    [held],
  );

  return {
    at,
    capture,
    clear,
    field: held?.field ?? null,
    message: held?.message ?? null,
  };
}
