import { forwardRef, useId } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import { mergeDescribedBy, useFormField } from "./FormFieldContext";

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  error?: boolean;
  errorMessage?: string;
  helperText?: string;
};

// Styled multiline input, matching <Input>'s look (border-border, bg-bg-tertiary,
// focus ring). Use inside a <FormField> for the label; the error/helper text here
// covers control-local validation feedback.
//
// `maxLength` also renders a counter, because the fields that carry one here are the operator prose
// stored in agent.settings, and every one of them is CLAMPED by its reader (see modules/agents/
// text-caps.ts). The browser stops new typing at the cap on its own; what it cannot show is a value
// that is ALREADY past it — pasted before the cap existed, imported, or written through the API —
// which is exactly the case where the text looks whole on screen and reaches the model cut short.
// Pass `maxLength` only for a field whose stored value is clamped or refused at that same number,
// since the over-limit message states both consequences.

// Below this fraction of the cap the counter is noise: the value is nowhere near the wall and the
// field should look like any other. At it, the operator gets warning before the wall, not at it.
const COUNTER_FROM = 0.8;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, errorMessage, helperText, rows = 5, ...props }, ref) => {
    const { t } = useTranslation();
    const field = useFormField();
    const max = typeof props.maxLength === "number" ? props.maxLength : null;
    // Raw length: the same thing the browser enforces `maxLength` against, and the same thing the
    // write boundary refuses on (see modules/agents/text-caps.ts). Measuring the trimmed value put
    // the control at odds with itself — leading spaces made it stop accepting characters while this
    // counter still showed room.
    const count = typeof props.value === "string" ? props.value.length : null;
    const over = max !== null && count !== null && count > max;
    const showCount =
      max !== null && count !== null && count >= max * COUNTER_FROM;
    // The field's `error` counts too: a FormField-level refusal has to mark the box it is about.
    const hasError = error || !!errorMessage || over || !!field.invalid;
    const descriptionId = useId();
    const hasDescription = !!errorMessage || !!helperText || over;
    return (
      <div className="w-full">
        <textarea
          // {...props} FIRST, so every attribute this component COMPUTES wins over the same one
          // passed in. The order used to be the reverse, and the spread then overwrote the merged
          // `aria-describedby`: a caller that described its control lost the field's own message,
          // which is how a validation message goes unannounced. Anything a caller may legitimately
          // override is folded into the computation instead of racing it.
          {...props}
          ref={ref}
          rows={rows}
          aria-invalid={hasError || undefined}
          id={props.id ?? field.controlId}
          aria-labelledby={props["aria-labelledby"] ?? field.labelledById}
          required={props.required ?? field.required}
          aria-describedby={mergeDescribedBy(
            field.describedById,
            props["aria-describedby"],
            hasDescription ? descriptionId : undefined,
          )}
          className={cn(
            // overflow-x-hidden: the textarea always wraps (pre-wrap + break-word), so it never needs a
            // horizontal scrollbar — pinning it off kills the spurious x-scrollbar track/flash.
            "w-full resize-y overflow-x-hidden rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder-text-placeholder focus:border-border-focus focus:outline-none disabled:opacity-60",
            { "border-error": hasError },
            className,
          )}
        />
        {showCount && (
          <span
            className={cn(
              "mt-1 block text-right text-xs",
              over ? "text-error" : "text-text-muted",
            )}
          >
            {`${count}/${max}`}
          </span>
        )}
        {errorMessage && (
          <span id={descriptionId} className="mt-1 block text-error text-xs">
            {errorMessage}
          </span>
        )}
        {over && !errorMessage && max !== null && count !== null && (
          <span id={descriptionId} className="mt-1 block text-error text-xs">
            {t(
              "common.charOverLimit",
              "{{over}} characters over the limit. The agent only receives the first {{max}}; shorten it to save a change to this field.",
              { over: count - max, max },
            )}
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

Textarea.displayName = "Textarea";
