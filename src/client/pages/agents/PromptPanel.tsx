import { Info, Lightbulb, Maximize2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown, Tooltip } from "@/client/components";
import {
  rehypeHighlightVars,
  wrapPreviewVar,
} from "@/client/lib/promptPreview";
import { cn } from "@/client/lib/utils";
import {
  buildPromptVars,
  findExactTimeVarUsages,
  interpolatePromptVars,
  PROMPT_CONTEXT_VARS,
  PROMPT_SCHEDULE_VARS_DISPLAY,
  PROMPT_TIME_VARS_DISPLAY,
  TIME_ROUND_MINUTES,
  timeVarKind,
} from "@/graph/prompt";
import type { Schedule } from "@/modules/business-hours/hours";
import { HighlightedPromptEditor } from "./HighlightedPromptEditor";

// Rich tooltip content for the {{var:FORMAT}} suffix help: the format tokens with descriptions, the
// MM-vs-mm gotcha, and live examples rendered through the real interpolatePromptVars (so they can
// never drift from the runtime). Only the date/time vars accept the :format suffix.
function FormatHelpTooltipContent() {
  const { t } = useTranslation();
  // Fixed reference instant so the examples are deterministic (14:30 on 18/06/2026 in the default tz).
  const exampleNow = new Date("2026-06-18T14:30:00-03:00");
  const render = (tpl: string) =>
    interpolatePromptVars(tpl, {}, { now: exampleNow });
  const tokens: Array<[string, string]> = [
    ["YYYY", t("editor.formatTokenYear", "year")],
    ["MM", t("editor.formatTokenMonth", "month (01-12)")],
    ["DD", t("editor.formatTokenDay", "day")],
    ["HH", t("editor.formatTokenHour", "hour (00-23)")],
    ["mm", t("editor.formatTokenMinute", "minute")],
    ["ss", t("editor.formatTokenSecond", "second")],
  ];
  const examples = [
    "{{data_atual}}",
    "{{data_atual:DD/MM}}",
    "{{hora_atual:HH:mm}}",
    "{{data_hora_atual:DD/MM HH:mm}}",
  ];
  // Derived per-var rounding label so the help never drifts from the runtime's TIME_VARS.
  const roundingBadge = (name: string): string => {
    switch (timeVarKind(name)) {
      case "rounded":
        return t("editor.roundingRounded", "rounded ({{minutes}} min)", {
          minutes: TIME_ROUND_MINUTES,
        });
      case "exact":
        return t("editor.roundingExact", "exact · changes every minute");
      default:
        return t("editor.roundingDate", "date");
    }
  };
  return (
    <div className="flex flex-col gap-2 text-left">
      <p className="font-semibold">
        {t("editor.formatHelpTitle", "Date and time format tokens")}
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {tokens.map(([tok, desc]) => (
          <span key={tok} className="flex gap-1.5">
            <code className="font-mono text-accent">{tok}</code>
            <span className="text-text-secondary">{desc}</span>
          </span>
        ))}
      </div>
      <p className="text-text-muted">
        {t(
          "editor.formatMonthMinuteNote",
          "MM is month, mm is minute (case matters).",
        )}
      </p>
      <div className="flex flex-col gap-0.5">
        <p className="font-semibold">
          {t("editor.formatExamplesTitle", "Examples")}
        </p>
        {examples.map((tpl) => (
          <span key={tpl} className="flex items-center gap-1.5 font-mono">
            <code>{tpl}</code>
            <span className="text-text-muted">{"→"}</span>
            <span className="text-text-secondary">{render(tpl)}</span>
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="font-semibold">
          {t("editor.roundingTitle", "Rounding (for caching)")}
        </p>
        {PROMPT_TIME_VARS_DISPLAY.map((name) => (
          <span key={name} className="flex items-center gap-1.5">
            <code className="font-mono text-accent">{`{{${name}}}`}</code>
            <span className="text-text-secondary">{roundingBadge(name)}</span>
          </span>
        ))}
        <p className="text-text-muted">
          {t(
            "editor.roundingNote",
            "Rounded values stay stable for {{minutes}} min, which improves prompt caching.",
            { minutes: TIME_ROUND_MINUTES },
          )}
        </p>
      </div>
    </div>
  );
}

interface PromptPanelProps {
  value: string;
  onChange: (v: string) => void;
  // Simulated context-var values shared with the playground (its "Prompt variables" panel), so the
  // preview and a playground turn resolve {{nome_contato}} etc. to the SAME values. Blank entries
  // fall back to the company/agent names or the built-in examples.
  previewVars?: Record<string, string>;
  // Fallbacks for {{nome_empresa}} / {{nome_agente}} when previewVars doesn't override them.
  companyFallback: string | null;
  agentFallback: string;
  // The agent's Availability, so the preview resolves {{esta_aberto}} & co. to what the runtime would
  // say right now. Mirrors interpolatePromptVars' own option: a null schedule means no Availability
  // configured (always on). Omitted → the schedule placeholders stay literal in the preview, which is
  // the honest render for a caller that cannot know.
  availability?: { schedule: Schedule | null };
  // "inline" → fixed-height editor + capped, scrollable preview (the editor card).
  // "fill"   → editor and preview grow to fill a tall flex parent (the expand-to-modal view).
  variant?: "inline" | "fill";
  // When set, renders an "expand" affordance in the editor header that opens the larger modal view.
  onExpand?: () => void;
}

// A single pane toggled between the editor and the live markdown preview (never both at once): the
// preview resolves the {{vars}} (current time + company/agent, example contact details) so the
// operator sees what the agent receives. Defaults to the editor. Self-contained (owns its textarea
// ref + insert-variable helper) so it can render twice at once, inline in the card and again, larger,
// inside the expand modal, each keeping its own editor/preview toggle over the shared prompt state.
export function PromptPanel({
  value,
  onChange,
  previewVars,
  companyFallback,
  agentFallback,
  availability,
  variant = "inline",
  onExpand,
}: PromptPanelProps) {
  const { t } = useTranslation();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [pane, setPane] = useState<"editor" | "preview">("editor");
  const fill = variant === "fill";
  // Exact time-of-day vars in the prompt defeat prompt caching; nudge toward the rounded sibling.
  const exactUsages = findExactTimeVarUsages(value);

  // Preview a context var from the shared playground values, falling back to the example / real one.
  const previewVar = (key: string, fallback: string | null) => {
    const v = previewVars?.[key];
    return typeof v === "string" && v.trim() !== "" ? v : fallback;
  };

  // Insert a {{variable}} at the caret (or append), then restore focus just past it.
  function insertVariable(name: string) {
    const token = `{{${name}}}`;
    const el = promptRef.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className={cn("flex flex-col gap-2", fill && "min-h-0 lg:h-full")}>
      <div className="flex shrink-0 items-center justify-between gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings UA border + legend baggage unfit for this small segmented toggle; role="group" + aria-label gives the same grouping semantics. */}
        <div
          role="group"
          aria-label={t("editor.promptViewToggle", "Editor or preview")}
          className="inline-flex rounded-lg border border-border bg-bg-tertiary p-0.5"
        >
          {(["editor", "preview"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPane(p)}
              aria-pressed={pane === p}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                pane === p
                  ? "bg-accent text-accent-foreground"
                  : "text-text-secondary hover:text-text-primary",
              )}
            >
              {p === "editor"
                ? t("editor.promptEditorLabel", "Editor")
                : t("editor.promptPreview", "Preview")}
            </button>
          ))}
        </div>
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-text-secondary text-xs hover:bg-bg-hover hover:text-text-primary"
          >
            <Maximize2 className="h-3 w-3" aria-hidden="true" />
            {t("editor.promptExpand", "Expand")}
          </button>
        )}
      </div>

      {pane === "editor" ? (
        <div className={cn("flex flex-col gap-2", fill && "min-h-0")}>
          <HighlightedPromptEditor
            ref={promptRef}
            value={value}
            onChange={onChange}
            rows={fill ? 24 : 12}
            fill={fill}
            aria-label={t("editor.systemPrompt", "Agent instructions")}
          />
          <div className="flex shrink-0 flex-col gap-1.5">
            <span className="flex items-center gap-1 text-text-muted text-xs">
              {t(
                "editor.promptVarsHint",
                "Insert a variable (dates also accept a :format suffix):",
              )}
              <Tooltip
                content={<FormatHelpTooltipContent />}
                align="start"
                contentClassName="max-w-sm"
              >
                <button
                  type="button"
                  aria-label={t(
                    "editor.formatHelpAria",
                    "Date and time format help",
                  )}
                  className="inline-flex text-text-muted hover:text-text-primary"
                >
                  <Info className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </Tooltip>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {[
                ...PROMPT_CONTEXT_VARS,
                ...PROMPT_TIME_VARS_DISPLAY,
                ...PROMPT_SCHEDULE_VARS_DISPLAY,
              ].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertVariable(v)}
                  className="rounded border border-border bg-bg-tertiary px-1.5 py-0.5 font-mono text-text-secondary text-xs hover:bg-bg-hover hover:text-text-primary"
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
            {exactUsages.length > 0 && (
              <div className="flex flex-col gap-1">
                {exactUsages.map(({ name, suggestion }) => (
                  <span
                    key={name}
                    className="flex items-start gap-1 text-warning text-xs"
                  >
                    <Lightbulb
                      className="mt-0.5 h-3 w-3 shrink-0"
                      aria-hidden="true"
                    />
                    <span>
                      {t(
                        "editor.exactTimeHint",
                        "{{exact}} is recomputed every minute, weakening prompt caching. If you don't need the exact minute, use {{rounded}}.",
                        { exact: name, rounded: suggestion },
                      )}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={cn("flex flex-col gap-2", fill && "min-h-0")}>
          <div
            className={cn(
              "w-full overflow-auto break-words rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary",
              fill ? "min-h-0 flex-1" : "max-h-80 min-h-60",
            )}
          >
            {value.trim() ? (
              <Markdown rehypePlugins={[rehypeHighlightVars]}>
                {interpolatePromptVars(
                  value,
                  buildPromptVars({
                    companyName: previewVar("nome_empresa", companyFallback),
                    agentName: previewVar("nome_agente", agentFallback),
                    contactName: previewVar("nome_contato", "Maria Silva"),
                    contactEmail: previewVar(
                      "email_contato",
                      "maria.silva@exemplo.com",
                    ),
                    contactPhone: previewVar(
                      "telefone_contato",
                      "+55 11 98888-7777",
                    ),
                    inboxName: previewVar("canal", "WhatsApp"),
                  }),
                  { wrap: wrapPreviewVar, availability },
                )}
              </Markdown>
            ) : (
              <span className="text-text-muted">
                {t("editor.promptPreviewEmpty", "The prompt is empty.")}
              </span>
            )}
          </div>
          <span className="shrink-0 text-text-muted text-xs">
            {t(
              "editor.promptPreviewNote",
              "Time is the current value; contact details are examples.",
            )}
          </span>
        </div>
      )}
    </div>
  );
}
