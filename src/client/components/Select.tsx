import { ChevronDown } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/client/lib/utils";
import { mergeDescribedBy, useFormField } from "./FormFieldContext";

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  error?: boolean;
  wrapperClassName?: string;
};

// Styled wrapper over the native <select> (keeps full keyboard/a11y behavior for
// free). Pass <option>s as children. The chevron is decorative; the native control
// still owns the popover.
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, wrapperClassName, error, children, ...props }, ref) => {
    // The id of the message the surrounding <FormField> renders, so this control can point
    // `aria-describedby` at it.
    const field = useFormField();
    // The field's `error` counts too: a FormField-level refusal has to mark the box it is about.
    // Computed once and used for BOTH the announcement and the drawing, because they had drifted:
    // `aria-invalid` already folded the field in while the border read only this control's own
    // prop, so a refusal raised at the field (`FormField error={refusal.at("method", …)}` in
    // ToolEditModal, and the same shape in IntegrationEditModal) turned every neighbouring
    // <Input> red and left the select looking untouched. A sighted operator saw no mark on the
    // control the sentence was about.
    const hasError =
      error ||
      !!field.invalid ||
      props["aria-invalid"] === true ||
      props["aria-invalid"] === "true";
    return (
      <div className={cn("relative w-full", wrapperClassName)}>
        <select
          // {...props} FIRST, for the reason spelled out in Input.tsx.
          {...props}
          ref={ref}
          aria-describedby={mergeDescribedBy(
            field.describedById,
            props["aria-describedby"],
          )}
          aria-invalid={hasError || undefined}
          id={props.id ?? field.controlId}
          aria-labelledby={props["aria-labelledby"] ?? field.labelledById}
          required={props.required ?? field.required}
          className={cn(
            "h-8 w-full appearance-none rounded-md border border-border-hover bg-bg-tertiary pr-9 pl-2.5 text-sm text-text-primary transition-colors focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-60",
            { "border-error": !!hasError },
            className,
          )}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-text-muted"
        />
      </div>
    );
  },
);

Select.displayName = "Select";
