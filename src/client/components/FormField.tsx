import {
  cloneElement,
  isValidElement,
  type ReactNode,
  useId,
  useMemo,
} from "react";
import { cn } from "@/client/lib/utils";
import {
  FormFieldContext,
  type FormFieldContextValue,
  mergeDescribedBy,
} from "./FormFieldContext";
import { HelpPopover } from "./HelpPopover";

interface FormFieldProps {
  label: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  hint?: ReactNode;
  // What the operator needs to DECIDE whether the field applies to them (why it exists, when to
  // use it, what it costs), as opposed to what they need to fill it correctly, which is
  // `description` and stays on screen. Rendered behind a `?` next to the label, so a page of forms
  // reads as a form instead of as prose with inputs in it. A POPOVER and not a tooltip, because a
  // tooltip cannot be opened by touch at all (see the note on Popover.tsx).
  help?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  // Use for a field whose children are NOT a single focusable control (a list with an "Add" button,
  // several inputs, a picker). See the component note.
  group?: boolean;
}

// A native control passed straight in (`<FormField><input /></FormField>`) cannot read the context,
// so everything the context carries would be decorative for it: the label's `for` would point at
// nothing, and the message would be announced nowhere. Injected instead.
//
// Restricted to these three tags on purpose. A native wrapper (`<div>`) would take `required` as an
// invalid DOM attribute, and a COMPOSITE child is either one of our own controls (which reads the
// context and merges it with its own props) or something that owns its accessibility itself.
const NATIVE_CONTROLS = new Set(["input", "select", "textarea"]);

function wireNativeControl(
  children: ReactNode,
  field: FormFieldContextValue,
): ReactNode {
  if (!isValidElement(children)) return children;
  if (typeof children.type !== "string") return children;
  if (!NATIVE_CONTROLS.has(children.type)) return children;
  const own = children.props as {
    id?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | string;
    required?: boolean;
  };
  return cloneElement(children, {
    // The TITLE alone, never the wrapping <label>: an accessible name is computed from the label's
    // whole subtree, so the `?` beside the title would be appended to the field's name.

    id: own.id ?? field.controlId,
    "aria-labelledby": own["aria-labelledby"] ?? field.labelledById,
    "aria-describedby": mergeDescribedBy(
      field.describedById,
      own["aria-describedby"],
    ),
    "aria-invalid": field.invalid || own["aria-invalid"],
    required: own.required ?? field.required,
  } as Partial<typeof own>);
}

// Label + control + (description | error) stack. THE LABEL POINTS AT THE CONTROL (`htmlFor`) and
// never wraps it: a wrapping <label> forwards a click on any non-interactive descendant, so the `?`
// (a `<span role="button">`) would toggle a wrapped checkbox, and a real <button> there would become
// the labelled control and take the input's name. Pointing also keeps the click target to the words.
// The MESSAGE is a sibling because an accessible name is computed from the whole label subtree; it
// reaches the control through `aria-describedby`. Pass `group` when the children are NOT a single
// focusable control: the wrapper carries `role="group"` + `aria-labelledby`, and the context hands
// down neither an id nor a label, or each child would be announced as the group.
export function FormField({
  label,
  children,
  description,
  hint,
  help,
  error,
  required,
  className,
  group,
}: FormFieldProps) {
  const subtext = description ?? hint;
  const titleId = useId();
  const generatedId = useId();
  const messageId = useId();
  // A child that brought its OWN id keeps it, and the label has to point at THAT: the control's own
  // id wins in every control here (`props.id ?? field.controlId`), so a label naming the generated
  // one would name nothing at all. Only a direct child can be read this way; a control buried in a
  // wrapper is a composite, which is what `group` is for.
  const childId =
    isValidElement(children) && typeof children.props === "object"
      ? (children.props as { id?: string }).id
      : undefined;
  const controlId = childId ?? generatedId;
  const hasMessage = !!error || !!subtext;

  const field = useMemo<FormFieldContextValue>(
    () => ({
      // In `group` mode the wrapper describes itself; handing the id down as well would make a
      // control inside announce the same message twice.
      describedById: hasMessage && !group ? messageId : undefined,
      // Both are for the ONE control a non-group field wraps. In `group` mode there is no such
      // control: handing the group's heading to every child would rename each of them after the
      // group (`aria-labelledby` beats a control's own `aria-label`), so a row of three inputs
      // would announce the same words three times.
      labelledById: group ? undefined : titleId,
      controlId: group ? undefined : controlId,
      // NOTE: also for the ONE control. A group's `required` and `error` are statements about the
      // COMPOSITE: handed down, one refusal would paint every <Input> inside red, and `required` would
      // make each part of the composite individually mandatory. The group says both on the wrapper.
      required: group ? undefined : required,
      invalid: group ? undefined : !!error,
    }),
    [group, hasMessage, messageId, titleId, controlId, required, error],
  );

  // A <label htmlFor> when there is one control to point at, a plain <span> in `group` mode where
  // there is not. Never a label WRAPPING the control: see the note above the component.
  const title = group ? (
    <span id={titleId}>
      {label}
      {required && <span className="ml-0.5 text-error">*</span>}
    </span>
  ) : (
    <label htmlFor={controlId} id={titleId}>
      {label}
      {required && <span className="ml-0.5 text-error">*</span>}
    </label>
  );

  const heading = (
    <span className="flex items-center gap-1.5 font-medium text-sm text-text-secondary">
      {title}
      {help ? (
        <HelpPopover
          content={help}
          label={typeof label === "string" ? label : undefined}
        />
      ) : null}
    </span>
  );

  const message = hasMessage ? (
    <span
      id={messageId}
      className={cn("text-xs", error ? "text-error" : "text-text-muted")}
    >
      {error ? error : subtext}
    </span>
  ) : null;

  return (
    <FormFieldContext.Provider value={field}>
      {group ? (
        // biome-ignore lint/a11y/useSemanticElements: a <fieldset>/<legend> brings UA border + legend-layout baggage unfit for this lightweight stacked field; role="group" + aria-labelledby gives the same grouping semantics.
        <div
          role="group"
          aria-labelledby={titleId}
          aria-describedby={hasMessage ? messageId : undefined}
          aria-invalid={error ? true : undefined}
          className={cn("flex flex-col gap-1.5", className)}
        >
          {heading}
          {children}
          {message}
        </div>
      ) : (
        <div className={cn("flex flex-col gap-1.5", className)}>
          {heading}
          {wireNativeControl(children, field)}
          {message}
        </div>
      )}
    </FormFieldContext.Provider>
  );
}
