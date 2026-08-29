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
    return (
      <div className={cn("relative w-full", wrapperClassName)}>
        <select
          ref={ref}
          aria-describedby={mergeDescribedBy(
            field.describedById,
            props["aria-describedby"],
          )}
          aria-invalid={error || field.invalid || undefined}
          aria-labelledby={props["aria-labelledby"] ?? field.labelledById}
          required={props.required ?? field.required}
          className={cn(
            "w-full appearance-none rounded-lg border border-border bg-bg-tertiary py-2 pr-9 pl-3 text-sm text-text-primary focus:border-border-focus focus:outline-none disabled:opacity-60",
            { "border-error": !!error },
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-text-muted"
        />
      </div>
    );
  },
);

Select.displayName = "Select";
