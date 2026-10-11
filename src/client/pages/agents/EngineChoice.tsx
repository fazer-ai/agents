import { Brain, ListChecks, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  type ChoiceCardOption,
  ChoiceCards,
} from "@/client/components";
import { cn } from "@/client/lib/utils";
import type { MonitoringEngine } from "@/modules/observe/settings";
import { CLASSIFIER_PATHS } from "./DecisionsFields";
import type { DecisionsIssueMap } from "./decisionsFormState";

// How a monitoring agent decides, chosen on General (agents#1224): two cards and not a select,
// because the choice swaps half of the editor (the prompt and the chat model for the classifier, the
// Knowledge tab for the Questions and rules tab), and the operator reads what each one does before
// picking. The screen follows the card at once, saved or not.
export function EngineCards({
  engine,
  onChange,
  missing,
}: {
  engine: MonitoringEngine;
  onChange: (engine: MonitoringEngine) => void;
  // What keeps the decision setup from being saved, said where the choice is made.
  missing?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const options: ChoiceCardOption<MonitoringEngine>[] = [
    {
      value: "llm",
      icon: Brain,
      title: t("editor.engineLlm", "Language model"),
      hint: t(
        "editor.engineLlmHint",
        "Reads the conversation with your instructions and acts with its tools. Flexible; takes a few seconds and costs more per message.",
      ),
    },
    {
      value: "decisions",
      icon: ListChecks,
      title: t("editor.engineDecisions", "Questions and rules"),
      hint: t(
        "editor.engineDecisionsHint",
        "Answers closed questions about the conversation and applies fixed rules. Under a second, cheap, and always the same for the same answer.",
      ),
    },
  ];
  return (
    <Card
      id="general-engine"
      className="flex scroll-mt-4 flex-col gap-4"
      data-testid="engine-cards"
    >
      <div>
        <h3 className="font-medium text-sm text-text-primary">
          {t("editor.engineSection", "How it decides")}
        </h3>
        <p className="text-text-muted text-xs">
          {t(
            "editor.engineSectionHint",
            "What reads each conversation this agent observes and chooses what to do.",
          )}
        </p>
      </div>
      <ChoiceCards
        value={engine}
        onChange={onChange}
        aria-label={t("editor.engineSection", "How it decides")}
        className="sm:grid-cols-2"
        options={options.map((o) => ({ ...o, testId: `engine-${o.value}` }))}
      />
      {missing}
    </Card>
  );
}

// The line under the cards that says what is still missing for the decision setup to be saved,
// with the way to each place it is fixed. Neutral until a Save is pressed; the press saves nothing
// (not the name either), turns the line into an error and goes to the first problem (saveAttempt.ts).
export function DecisionsSetupMissing({
  issues,
  onOpenDecisions,
  showErrors = false,
}: {
  issues: DecisionsIssueMap;
  onOpenDecisions: () => void;
  showErrors?: boolean;
}) {
  const { t } = useTranslation();
  if (issues.size === 0) return null;
  const paths = [...issues.keys()];
  const key = paths.includes("credentialRef");
  const classifier = paths.some(
    (p) => CLASSIFIER_PATHS.has(p) && p !== "credentialRef",
  );
  const noQuestion = paths.includes("questions");
  const body = paths.filter(
    (p) => !CLASSIFIER_PATHS.has(p) && p !== "questions",
  ).length;
  const items: string[] = [];
  if (key) {
    items.push(
      t("editor.engineMissingKey", "choose the classifier's API key below"),
    );
  }
  if (classifier) {
    items.push(t("editor.engineMissingClassifier", "fix the classifier below"));
  }
  if (noQuestion) {
    items.push(
      t(
        "editor.engineMissingQuestion",
        "add at least one question in Questions and rules",
      ),
    );
  }
  if (body > 0) {
    items.push(
      t(
        "editor.engineMissingBody",
        "fix {{count}} problems in Questions and rules",
        { count: body },
      ),
    );
  }
  return (
    <div
      role={showErrors ? "alert" : "status"}
      data-testid="engine-missing"
      data-tone={showErrors ? "error" : "neutral"}
      data-problems-summary
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-text-primary text-xs",
        showErrors
          ? "border-error bg-error-soft"
          : "border-warning bg-warning-soft",
      )}
    >
      <TriangleAlert
        className={cn(
          "h-4 w-4 shrink-0",
          showErrors ? "text-error" : "text-warning",
        )}
        aria-hidden="true"
      />
      <span className="flex-1">
        {t("editor.engineMissing", "To save: {{items}}.", {
          items: items.join("; "),
        })}
      </span>
      {(noQuestion || body > 0) && (
        <Button size="sm" variant="secondary" onClick={onOpenDecisions}>
          {t("editor.engineOpenDecisions", "Open Questions and rules")}
        </Button>
      )}
    </div>
  );
}
