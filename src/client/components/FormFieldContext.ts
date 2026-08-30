import { createContext, useContext } from "react";

// What a <FormField> hands down to the control it wraps. It exists because the field owns the ids
// (it renders the label and the message) while the control owns the element those ids have to land
// on, and nothing in between can pass a prop through composition.
export interface FormFieldContextValue {
  // The field's own message (its inline description, or its error), which the control must point
  // `aria-describedby` at. Merged with any `aria-describedby` the control already renders for a
  // message of its own, rather than replacing it.
  describedById?: string;
  // The id of the element holding the field's TITLE and nothing else. A control points
  // `aria-labelledby` at it so its name is the title, which is not what the wrapping <label> would
  // give: the accessible name is computed from the label's whole subtree, so the `?` next to the
  // title (a `role="button"` carrying its own aria-label) would be appended to the field's name.
  // `aria-labelledby` wins over a native label, so the <label> keeps giving click-to-focus and
  // stops deciding the name.
  labelledById?: string;
  // The id the field's <label> points `htmlFor` at, so the control has to CARRY it. The label no
  // longer wraps the control: a wrapping label forwards a click on any non-interactive descendant
  // to the control it labels, and the `?` is a `<span role="button">`, which ARIA makes operable
  // but does NOT make interactive content in the HTML sense. Measured: clicking the `?` on a field
  // wrapping a checkbox toggled the checkbox.
  controlId?: string;
  required?: boolean;
  invalid?: boolean;
}

export const FormFieldContext = createContext<FormFieldContextValue>({});

export function useFormField(): FormFieldContextValue {
  return useContext(FormFieldContext);
}

// `aria-describedby` takes a LIST of ids, so a control that renders its own message and sits in a
// field that renders one must name both — dropping either is how a validation message goes
// unannounced. Order is meaningful: assistive tech reads them in sequence, and the field's own
// description is the general one, so it comes first.
export function mergeDescribedBy(
  ...ids: (string | undefined)[]
): string | undefined {
  const present = ids.filter((id): id is string => !!id);
  return present.length > 0 ? present.join(" ") : undefined;
}
