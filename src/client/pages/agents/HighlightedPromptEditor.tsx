import { forwardRef } from "react";
import { HighlightedTemplateField } from "@/client/components/HighlightedTemplateField";
import { isKnownPromptVar, PROMPT_PLACEHOLDER_SOURCE } from "@/graph/prompt";

// Prompt textarea with inline {{variable}} highlighting. A thin wrapper over the generic
// HighlightedTemplateField, wired with the prompt's placeholder pattern and known-variable set. The
// ref forwards to the inner <textarea> so the editor's "insert variable" helper still works.
export const HighlightedPromptEditor = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    rows?: number;
    // Grow to fill a flex-column parent instead of the fixed `rows` (the expand-to-modal view).
    fill?: boolean;
    // Declares a cap on the control (counter + over-limit line). The system prompt is deliberately
    // uncapped and passes nothing; the signature field passes SIGNATURE_MAX.
    maxLength?: number;
    onSelect?: () => void;
    "aria-label"?: string;
  }
>(
  (
    {
      value,
      onChange,
      rows = 10,
      fill,
      maxLength,
      onSelect,
      "aria-label": ariaLabel,
    },
    ref,
  ) => (
    <HighlightedTemplateField
      ref={ref}
      value={value}
      onChange={onChange}
      isKnownToken={isKnownPromptVar}
      patternSource={PROMPT_PLACEHOLDER_SOURCE}
      multiline
      rows={rows}
      fill={fill}
      maxLength={maxLength}
      onSelect={onSelect}
      aria-label={ariaLabel}
    />
  ),
);

HighlightedPromptEditor.displayName = "HighlightedPromptEditor";
