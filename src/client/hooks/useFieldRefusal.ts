import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { placeRefusal, readRefusal } from "@/client/lib/fieldRefusal";

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
  // Take a failed call. Returns the sentence the caller must TOAST, or null when it landed on an
  // input and the toast must stay silent. `sent` is what this request carried and `current` is what
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
  field: string | null;
}

export function useFieldRefusal(rendered: readonly string[]): FieldRefusal {
  const [held, setHeld] = useState<{
    field: string;
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

  // The declared list is a literal at almost every call site (`COMPANY_FIELDS`), but a caller that
  // builds it inline would otherwise hand `capture` a new identity on every render.
  const key = rendered.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` IS `rendered`, by value.
  const fields = useMemo(() => rendered.slice(), [key]);

  const capture = useCallback(
    (
      e: unknown,
      fallback: string,
      sent: Record<string, unknown>,
      current: Record<string, unknown>,
    ) => {
      const placed = placeRefusal(readRefusal(e), fields, fallback, {
        mounted: mounted.current,
        sent,
        current,
      });
      if (placed.at !== undefined) {
        setHeld({
          field: placed.at,
          message: placed.message,
          value: placed.value,
        });
        return null;
      }
      // NOTE: written even when nothing is placed, and that is the whole of "the capture is also the
      // clear": a mark left over from a refusal the server has stopped making would sit on a control
      // while the toast says something else.
      setHeld(null);
      return placed.toast;
    },
    [fields],
  );

  const clear = useCallback(() => setHeld(null), []);

  const at = useCallback(
    (field: string, value: unknown) =>
      held?.field === field && held.value === value ? held.message : null,
    [held],
  );

  return { at, capture, clear, field: held?.field ?? null };
}
