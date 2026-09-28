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
  // argument is a type error, where a forgotten `clear(field)` would be invisible.
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
  // The standing refusal's sentence, whether or not it could be placed at an input. Here rather than
  // in the caller: a caller's own copy is a SECOND source of truth that drifts unseen (it outlives the
  // mark, carries the wrong owner, survives a second refusal about the same field). Expires with the
  // hold, never on its own: every `capture` overwrites it and `clear` drops it. A caller rendering it
  // for a PLACED mark still asks `at`, which expires by value.
  message: string | null;
}

// `rendered` is what the form is DRAWING RIGHT NOW, per render: a form hides some of its own controls
// (the setup token where enforcement is off, the vault's per-key inputs once it pastes a `.env`, a
// dialog's other tab), and a refusal marked on an undrawn control is silence with the toast held
// back. A form that is not on screen renders nothing, which is `[]`. Read through a ref, because the
// answer is needed AFTER the await, and a submit handler closes over the render it started in.
// `owned` is every name the form can mark, drawn or not; leave it out when all controls are on
// screen together. The agent editor (values behind tabs) is the one that needs it. See placeRefusal.
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
      // NOTE: for most holders the caller's OTHER channel is inside the form too (an error line in the
      // dialog, cleared by `useOnModalOpen` on the next opening), so handing it a sentence for a dismissed
      // form only moves the silence. So when the form is gone the hook raises the global toast itself, but
      // only for a sentence it HAS: an empty fallback is a caller wording the refusal better than the
      // server can (ChannelsPage names the affordance), and swallowing its turn would be silence again.
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
