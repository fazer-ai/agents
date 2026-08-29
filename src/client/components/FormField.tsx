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
  // reads as a form instead of as prose with inputs in it (issue #411).
  //
  // A POPOVER and not a tooltip, because a tooltip cannot be opened by touch at all, measured in
  // the note on Popover.tsx.
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
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean | string;
    required?: boolean;
  };
  return cloneElement(children, {
    // The TITLE alone, never the wrapping <label>: an accessible name is computed from the label's
    // whole subtree, so the `?` beside the title would be appended to the field's name.

    "aria-labelledby": own["aria-labelledby"] ?? field.labelledById,
    "aria-describedby": mergeDescribedBy(
      field.describedById,
      own["aria-describedby"],
    ),
    "aria-invalid": field.invalid || own["aria-invalid"],
    required: own.required ?? field.required,
  } as Partial<typeof own>);
}

// Label + control + (description | error) stack.
//
// THE LABEL WRAPS THE CONTROL, which makes the field's accessible name a property of what is inside
// that <label>, and that is why the `?` next to the title is a span with `role="button"` and not a
// <button>. A <label> is associated with the first LABELABLE element in its subtree, and `button`
// is labelable: as a button, the help trigger became the labelled control, so clicking the title
// opened the help instead of focusing the input and the input lost its name. Measured, and the same
// trap the `group` note below describes from the other side. See HelpPopover.tsx.
//
// The MESSAGE sits outside the <label> for the same algorithm read the other way: an accessible
// name is computed from the whole label subtree, so a description or an error rendered in there
// would be appended to the field's name instead of describing it. It reaches the control through
// `aria-describedby` (FormFieldContext) rather than through containment.
//
// Pass `group` when the children are NOT a single focusable control. There is no one element for a
// label to name, so the wrapper carries `role="group"` + `aria-labelledby` instead: screen readers
// still announce the group, and no click is forwarded anywhere.
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
  const messageId = useId();
  const hasMessage = !!error || !!subtext;

  const field = useMemo<FormFieldContextValue>(
    () => ({
      // In `group` mode the wrapper describes itself; handing the id down as well would make a
      // control inside announce the same message twice.
      describedById: hasMessage && !group ? messageId : undefined,
      labelledById: titleId,
      required,
      invalid: !!error,
    }),
    [group, hasMessage, messageId, titleId, required, error],
  );

  const title = (
    <span id={titleId}>
      {label}
      {required && <span className="ml-0.5 text-error">*</span>}
    </span>
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
          className={cn("flex flex-col gap-1.5", className)}
        >
          {heading}
          {children}
          {message}
        </div>
      ) : (
        <div className={cn("flex flex-col gap-1.5", className)}>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the control arrives as children (a real input/select/textarea); the rule cannot see through composition. */}
          <label className="flex flex-col gap-1.5">
            {heading}
            {wireNativeControl(children, field)}
          </label>
          {message}
        </div>
      )}
    </FormFieldContext.Provider>
  );
}
