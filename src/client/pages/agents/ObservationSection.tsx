import { Eye } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { FormField, Input, Select } from "@/client/components";
import {
  OBSERVATION_LIMITS,
  type ObservationState,
} from "./observationFormState";
import { Section } from "./SectionNav";

// The Behavior tab's Observation block (issue #494): WHEN a monitoring agent looks, and how much of
// the conversation it reads. Drawn only for an agent in monitoring mode.
//
// What it does with what it reads is no longer configured here (issue #568). It used to be: a
// taxonomy of label groups, because the mode was a classifier. A watcher is now the ordinary agent
// that cannot answer the customer, so its behaviour is its prompt and its tools, on the same tabs
// every other agent uses.
export function ObservationSection({
  observation,
  setObservation,
}: {
  observation: ObservationState;
  setObservation: React.Dispatch<React.SetStateAction<ObservationState>>;
}) {
  const { t } = useTranslation();
  const lim = OBSERVATION_LIMITS;
  const patch = (p: Partial<ObservationState>) =>
    setObservation((prev) => ({ ...prev, ...p }));

  return (
    <Section
      id="observation"
      icon={Eye}
      title={t("editor.observation", "Observation")}
      description={t(
        "editor.observationHint",
        "When this agent looks at the conversation, and how much of it it reads.",
      )}
      help={t(
        "editor.observationHelp",
        "A monitoring agent reads every message of the inboxes it observes and answers none of them. It is the ordinary agent, with its prompt, its tools, its knowledge and its MCP servers, minus the one thing it cannot do: post something the customer sees.\n\nSo what it DOES is configured where every agent's behaviour is: the prompt says what to watch for, and the Tools tab says what it may act with. Labelling the conversation, leaving a private note, setting an attribute and moving a card are all tools it can be given.\n\nThis block is only about when it looks. It runs after each burst of customer messages, or only when the conversation is resolved. To switch it off, disable the agent or take it off the inbox.",
      )}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label={t("editor.observationAnalysis", "When to classify")}
          description={t(
            "editor.observationAnalysisHint",
            "Per burst also runs a final pass when the conversation is resolved.",
          )}
        >
          <Select
            value={observation.analysis}
            onChange={(e) =>
              patch({
                analysis:
                  e.target.value === "on_resolve"
                    ? "on_resolve"
                    : "incremental",
              })
            }
          >
            <option value="incremental">
              {t(
                "editor.observationAnalysisIncremental",
                "After each burst of customer messages",
              )}
            </option>
            <option value="on_resolve">
              {t(
                "editor.observationAnalysisOnResolve",
                "Only when the conversation is resolved",
              )}
            </option>
          </Select>
        </FormField>
        <FormField
          label={t("editor.observationWindow", "Messages read")}
          description={t(
            "editor.observationWindowHint",
            "The newest messages the model reads on each pass. {{min}}-{{max}}.",
            { min: lim.windowMessagesMin, max: lim.windowMessagesMax },
          )}
        >
          <Input
            type="number"
            min={lim.windowMessagesMin}
            max={lim.windowMessagesMax}
            value={observation.windowMessages}
            onChange={(e) => patch({ windowMessages: e.target.value })}
          />
        </FormField>
        <FormField
          label={t("editor.observationBurst", "Burst window (seconds)")}
          description={t(
            "editor.observationBurstHint",
            "Customer messages closer than this are judged together. {{min}}-{{max}}.",
            { min: lim.secondsMin, max: lim.secondsMax },
          )}
        >
          <Input
            type="number"
            min={lim.secondsMin}
            max={lim.secondsMax}
            value={observation.windowSeconds}
            onChange={(e) => patch({ windowSeconds: e.target.value })}
          />
        </FormField>
        <FormField
          label={t("editor.observationBurstMax", "Burst ceiling (seconds)")}
          description={t(
            "editor.observationBurstMaxHint",
            "A customer who keeps writing is judged at the latest this long after the first message.",
          )}
        >
          <Input
            type="number"
            min={lim.secondsMin}
            max={lim.secondsMax}
            value={observation.maxWindowSeconds}
            onChange={(e) => patch({ maxWindowSeconds: e.target.value })}
          />
        </FormField>
      </div>
    </Section>
  );
}
