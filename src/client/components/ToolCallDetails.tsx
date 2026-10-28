import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

// Shared monospace block for a tool call's arguments / result. Used by the conversation timeline's
// expandable tool marker and the playground trace, so both render tool I/O identically.
export function TracePre({ children }: { children: ReactNode }) {
  return (
    <pre className="bg-bg-tertiary text-text-muted overflow-x-auto rounded px-2 py-1 text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

// The arguments + result of a single tool call (already redacted/truncated upstream). Arguments are
// pretty-printed JSON (or the raw string when not JSON); the result is shown verbatim. Renders nothing
// when both are empty.
export function ToolCallDetails({
  args,
  output,
  error,
}: {
  args?: unknown;
  output?: string | null;
  // The sanitized failure message when the tool errored. Rendered as a distinct red block so the
  // operator sees WHY it failed, not just that it did.
  error?: string | null;
}) {
  const { t } = useTranslation();
  const showArgs = !isEmpty(args);
  const showOutput = !isEmpty(output);
  const showError = !isEmpty(error);
  if (!showArgs && !showOutput && !showError) return null;
  return (
    <div className="flex flex-col gap-1.5 text-left">
      {showArgs && (
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted text-[10px] font-medium tracking-wider uppercase">
            {t("conversation.trail.args", "Arguments")}
          </span>
          <TracePre>
            {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
          </TracePre>
        </div>
      )}
      {showOutput && (
        <div className="flex flex-col gap-0.5">
          <span className="text-text-muted text-[10px] font-medium tracking-wider uppercase">
            {t("conversation.trail.result", "Result")}
          </span>
          <TracePre>{output}</TracePre>
        </div>
      )}
      {showError && (
        <div className="flex flex-col gap-0.5">
          <span className="text-error text-[10px] font-medium tracking-wider uppercase">
            {t("conversation.trail.error", "Error")}
          </span>
          <pre className="bg-bg-tertiary text-error overflow-x-auto rounded px-2 py-1 text-xs whitespace-pre-wrap">
            {error}
          </pre>
        </div>
      )}
    </div>
  );
}
