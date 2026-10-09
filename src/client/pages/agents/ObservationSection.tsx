import { Eye } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import { FormField, Input, Select } from "@/client/components";
import { decisionsBlockFingerprint } from "@/modules/decisions/config";
import {
  DecisionsFields,
  type DecisionsServerRefusal,
} from "./DecisionsFields";
import { emptyDecisionsForm } from "./decisionsFormState";
import {
  OBSERVATION_LIMITS,
  type ObservationState,
} from "./observationFormState";
import { Section } from "./SectionNav";

// The Behavior tab's Observation block: WHEN a monitoring agent looks, how much of the conversation
// it reads, and WHAT DECIDES: the agent's model with its prompt and tools, or the decisions engine
// with its questions and rules (./DecisionsFields). Drawn only for an agent in monitoring mode.
export function ObservationSection({
  agentId,
  savedAt,
  observation,
  setObservation,
  decisionsCredentialError,
  decisionsRefusal,
}: {
  agentId: string;
  savedAt: string | null;
  observation: ObservationState;
  setObservation: React.Dispatch<React.SetStateAction<ObservationState>>;
  decisionsCredentialError: string | null;
  decisionsRefusal: DecisionsServerRefusal | null;
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
            "Customer messages closer than this are judged together. {{min}}-{{max}}. With 0 every message is judged as it arrives, one model call per message.",
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
      <FormField
        label={t("editor.decisionsEngine", "What decides")}
        description={
          observation.engine === "decisions"
            ? t(
                "editor.decisionsEngineDecisionsHint",
                "A classification API answers the questions below and the rules turn the answers into actions. No chat model runs, and the prompt is not read.",
              )
            : t(
                "editor.decisionsEngineLlmHint",
                "The agent's model reads the conversation with its prompt and acts with its tools.",
              )
        }
        help={t(
          "editor.decisionsEngineHelp",
          "The decisions engine asks typed questions (yes or no, one of a list, a level on a scale) and gets back probabilities, in a fraction of the time and cost of a model turn. What it does with them is fixed by rules you write here, so the same answer always leads to the same action.\n\nStart in shadow: it decides and logs what each rule would have done, and writes nothing. Switch to enforce once the log shows what you expect.\n\nSwitching back to the model keeps the questions and rules for the next time.",
        )}
      >
        <Select
          value={observation.engine}
          onChange={(e) =>
            setObservation((prev) => ({
              ...prev,
              engine: e.target.value === "decisions" ? "decisions" : "llm",
              // A first switch starts from an empty block in shadow, so nothing is written before
              // the operator has read what it would do.
              decisions:
                e.target.value === "decisions" && prev.decisions === null
                  ? {
                      ...emptyDecisionsForm(),
                      provider: "openai",
                      apply: "shadow",
                    }
                  : prev.decisions,
            }))
          }
        >
          <option value="llm">
            {t(
              "editor.decisionsEngineLlm",
              "The agent's model (prompt and tools)",
            )}
          </option>
          <option value="decisions">
            {t(
              "editor.decisionsEngineDecisions",
              "Decisions engine (questions and rules)",
            )}
          </option>
        </Select>
      </FormField>
      {observation.engine === "decisions" && observation.decisions && (
        <DecisionsFields
          agentId={agentId}
          savedAt={savedAt}
          storedBlock={decisionsBlockFingerprint(observation.storedDecisions)}
          decisions={observation.decisions}
          setDecisions={(next) =>
            setObservation((prev) =>
              prev.decisions
                ? { ...prev, decisions: next(prev.decisions) }
                : prev,
            )
          }
          credentialError={decisionsCredentialError}
          serverRefusal={decisionsRefusal}
        />
      )}
    </Section>
  );
}
