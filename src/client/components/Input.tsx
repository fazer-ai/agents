import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import { mergeDescribedBy, useFormField } from "./FormFieldContext";

type BaseInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  error?: boolean;
  errorMessage?: string;
  helperText?: string;
  wrapperClassName?: string;
};

type PasswordToggleInputProps = BaseInputProps & {
  showPasswordToggle: true;
  type: "password";
};

type RegularInputProps = BaseInputProps & {
  showPasswordToggle?: false;
  type?: React.InputHTMLAttributes<HTMLInputElement>["type"];
};

type InputProps = PasswordToggleInputProps | RegularInputProps;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      wrapperClassName,
      error,
      errorMessage,
      helperText,
      showPasswordToggle,
      type,
      autoComplete,
      ...props
    },
    ref,
  ) => {
    const { t } = useTranslation();
    // The id of the message the surrounding <FormField> renders, so this control can point
    // `aria-describedby` at it. Without this the field's own description is announced nowhere.
    const field = useFormField();
    // The field's `error` counts too: a FormField-level refusal has to mark the box it is about.
    const hasError =
      error ||
      !!errorMessage ||
      !!field.invalid ||
      props["aria-invalid"] === true ||
      props["aria-invalid"] === "true";
    const descriptionId = useId();
    const hasDescription = !!errorMessage || !!helperText;
    const [showPassword, setShowPassword] = useState(false);

    return (
      <div className={cn("w-full", wrapperClassName)}>
        <div className={cn("relative", wrapperClassName && "h-full")}>
          <input
            // {...props} FIRST, so every attribute this component COMPUTES wins over the same one
            // passed in. The order used to be the reverse, and the spread then overwrote the merged
            // `aria-describedby`: a caller that described its control lost the field's own message,
            // which is how a validation message goes unannounced. Anything a caller may legitimately
            // override is folded into the computation instead of racing it.
            {...props}
            ref={ref}
            type={showPasswordToggle && showPassword ? "text" : type}
            autoComplete={
              showPasswordToggle
                ? (autoComplete ?? "new-password")
                : autoComplete
            }
            aria-invalid={hasError || undefined}
            id={props.id ?? field.controlId}
            aria-labelledby={props["aria-labelledby"] ?? field.labelledById}
            required={props.required ?? field.required}
            // BOTH ids, not one: the field describes the control in general and this control
            // describes its own state. Replacing either is how a validation message goes unread.
            aria-describedby={mergeDescribedBy(
              field.describedById,
              props["aria-describedby"],
              hasDescription ? descriptionId : undefined,
            )}
            className={cn(
              "w-full rounded-lg border border-border bg-bg-tertiary px-4 py-2 text-text-primary placeholder-text-placeholder focus:border-border-focus focus:outline-none disabled:opacity-60",
              { "border-error": hasError, "pr-10": !!showPasswordToggle },
              className,
            )}
          />
          {showPasswordToggle && (
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute top-1/2 right-3 -translate-y-1/2 text-text-muted hover:text-text-primary"
              tabIndex={-1}
              aria-label={
                showPassword
                  ? t("common.hidePassword", "Hide password")
                  : t("common.showPassword", "Show password")
              }
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
        {errorMessage && (
          <span id={descriptionId} className="mt-1 block text-error text-xs">
            {errorMessage}
          </span>
        )}
        {helperText && !errorMessage && (
          <span
            id={descriptionId}
            className="mt-1 block text-text-muted text-xs"
          >
            {helperText}
          </span>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";
