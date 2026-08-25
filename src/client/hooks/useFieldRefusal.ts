import { useCallback, useMemo, useState } from "react";
import {
  placeRefusal,
  type Refusal,
  readRefusal,
} from "@/client/lib/fieldRefusal";

// A form's held refusal: which input the server refused, and what it said about it.
//
// PER FORM, not per page and not in a context. Two forms are on screen together all the time here — a
// modal over the panel that opened it — and both have a `name`. A shared store would mark the page
// behind the modal, and a store that outlives the form would still be holding a refusal when the
// operator closes a modal and opens it again.
export interface FieldRefusal {
  // The message to render at `field`, or null when this input is not the one refused. Goes straight
  // into `<FormField error={...}>`, which already has the slot.
  at: (field: string) => string | null;
  // Take a failed call. Returns the sentence the caller must TOAST, or null when it landed on an
  // input and the toast must stay silent. One line at the call site, because the sweep that follows
  // (#233) applies it a hundred times and a two-line idiom is one that gets applied unevenly.
  capture: (e: unknown, fallback: string) => string | null;
  // Drop the mark: one input (the operator edited it) or all of them (the save went through).
  //
  // A refused resubmit needs no clear — `capture` is the only writer of this state and always
  // replaces it, so the refusal on screen is always the one the server last answered. Two marks
  // would claim it refused twice.
  clear: (field?: string) => void;
  // The input currently marked, for a caller that has to go somewhere to show it: the agent editor's
  // fields live behind tabs, and a mark on a tab nobody is looking at is not yet visible. Nothing
  // here navigates — which tab holds which path is the screen's knowledge, not this hook's.
  field: string | null;
}

export function useFieldRefusal(rendered: readonly string[]): FieldRefusal {
  const [held, setHeld] = useState<Required<Refusal> | null>(null);
  // The declared list is a literal at almost every call site (`COMPANY_FIELDS`), but a caller that
  // builds it inline would otherwise hand `capture` a new identity on every render.
  const key = rendered.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` IS `rendered`, by value.
  const fields = useMemo(() => rendered.slice(), [key]);

  const capture = useCallback(
    (e: unknown, fallback: string) => {
      const placed = placeRefusal(readRefusal(e), fields, fallback);
      if (placed.at !== undefined) {
        setHeld({ field: placed.at, message: placed.message });
        return null;
      }
      // Written even when nothing is placed, and that is the whole of "the capture is also the
      // clear": a mark left over from a refusal the server has stopped making would sit on a control
      // while the toast says something else.
      setHeld(null);
      return placed.toast;
    },
    [fields],
  );

  const clear = useCallback((field?: string) => {
    setHeld((current) =>
      !current || field === undefined || current.field === field
        ? null
        : current,
    );
  }, []);

  const at = useCallback(
    (field: string) => (held?.field === field ? held.message : null),
    [held],
  );

  return { at, capture, clear, field: held?.field ?? null };
}
