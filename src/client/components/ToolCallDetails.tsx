import { type ReactNode, useState } from "react";
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
  fullOutputChars,
  fullOutputCut,
  loadFullOutput,
  outputNote,
}: {
  args?: unknown;
  output?: string | null;
  // The sanitized failure message when the tool errored. Rendered as a distinct red block so the
  // operator sees WHY it failed, not just that it did.
  error?: string | null;
  // The length of the whole result when the log kept it beside a cut `output`. The text is fetched
  // by `loadFullOutput` on the first click of the toggle, since it can run to tens of thousands of
  // characters and the conversation that lists sixty calls is refreshed while it is open.
  fullOutputChars?: number | null;
  loadFullOutput?: () => Promise<string | null>;
  // The kept copy stopped at its own ceiling, so the toggle must not call it the whole result.
  fullOutputCut?: boolean | null;
  // A sentence under the result saying it is cut and why the whole one is not here.
  outputNote?: string | null;
}) {
  const { t } = useTranslation();
  const [showFull, setShowFull] = useState(false);
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const offersFull = fullOutputChars != null && !!loadFullOutput;
  const showArgs = !isEmpty(args);
  // The section stays when the logged copy came out empty (the row's budget spent on the arguments)
  // but a kept whole result or a note about it exists: those are the only way to the result then.
  const showOutput = !isEmpty(output) || offersFull || !!outputNote;
  const toggleFull = async () => {
    if (showFull) return setShowFull(false);
    if (fullOutput !== null) return setShowFull(true);
    if (!loadFullOutput) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const text = await loadFullOutput();
      if (text === null) return setLoadFailed(true);
      setFullOutput(text);
      setShowFull(true);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };
  const chars = (fullOutputChars ?? 0).toLocaleString();
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
          {showFull && fullOutput ? (
            <pre className="bg-bg-tertiary text-text-muted max-h-96 overflow-auto rounded px-2 py-1 text-xs whitespace-pre-wrap">
              {fullOutput}
            </pre>
          ) : (
            !isEmpty(output) && <TracePre>{output}</TracePre>
          )}
          {offersFull && (
            <button
              type="button"
              onClick={toggleFull}
              disabled={loading}
              className="text-accent self-start text-xs hover:underline disabled:opacity-60"
            >
              {loading
                ? t(
                    "conversation.trail.loadingFullResult",
                    "Loading the result…",
                  )
                : showFull
                  ? t("conversation.trail.showCutResult", "Show the cut result")
                  : fullOutputCut
                    ? t("conversation.trail.showKeptResult", {
                        defaultValue:
                          "Show the kept result (its first {{chars}} characters; the call returned more)",
                        chars,
                      })
                    : t("conversation.trail.showFullResult", {
                        defaultValue:
                          "Show the whole result ({{chars}} characters)",
                        chars,
                      })}
            </button>
          )}
          {loadFailed && (
            <span className="text-error text-xs">
              {t(
                "conversation.trail.fullResultLoadFailed",
                "The whole result could not be loaded. It may have just expired; reload the conversation.",
              )}
            </span>
          )}
          {outputNote && (
            <span className="text-text-muted text-xs">{outputNote}</span>
          )}
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
