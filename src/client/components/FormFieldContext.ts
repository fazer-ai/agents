import { createContext, useContext } from "react";

// What a <FormField> hands down to the control it wraps. It exists because the field owns the ids
// (it renders the label and the message) while the control owns the element those ids have to land
// on, and nothing in between can pass a prop through composition.
export interface FormFieldContextValue {
  // The field's own message (its inline description, or its error), which the control must point
  // `aria-describedby` at. Merged with any `aria-describedby` the control already renders for a
  // message of its own, rather than replacing it.
  describedById?: string;
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
