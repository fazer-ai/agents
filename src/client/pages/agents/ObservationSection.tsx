import { Eye, Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Select,
  SwitchField,
  Textarea,
} from "@/client/components";
import {
  groupIncomplete,
  OBSERVATION_LIMITS,
  type ObservationState,
} from "./observationFormState";
import { Section } from "./SectionNav";

// The Behavior tab's Observation block (issue #494): what a monitoring agent DOES with what it
// reads (issue #477), which until this section existed had no screen at all — `settings.monitoring`
// was reachable through REST and MCP only, so a watcher created in the console observed nothing
// until somebody reached for the API. Drawn only for an agent in monitoring mode, first in the tab,
// because it is the one block that runs for such an agent.
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
  const patchGroup = (
    i: number,
    p: Partial<ObservationState["groups"][number]>,
  ) =>
    setObservation((prev) => ({
      ...prev,
      groups: prev.groups.map((g, j) => (j === i ? { ...g, ...p } : g)),
    }));
  const atMax = observation.groups.length >= lim.groupsMax;

  return (
    <Section
      id="observation"
      icon={Eye}
      title={t("editor.observation", "Observation")}
      description={t(
        "editor.observationHint",
        "What this agent does with what it reads: a verdict per group of labels, written on the conversation as it happens.",
      )}
      help={t(
        "editor.observationHelp",
        "A monitoring agent reads every message of the inboxes it observes and answers none. This block is what it does with what it reads.\n\nWith at least one label group, it classifies the conversation after each burst of customer messages (or only on resolve) and writes the verdict as Chatwoot labels: an exclusive group keeps one value at a time, an additive one accumulates. A changed label gets a private note saying why.\n\nWith no group, observation is off and the agent costs nothing. The labels must already exist on the Chatwoot account; a verdict outside the list is refused.",
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
      <SwitchField
        checked={observation.noteOnChange}
        onCheckedChange={(v) => patch({ noteOnChange: v })}
        label={t(
          "editor.observationNote",
          "Leave a private note when a verdict changes a label",
        )}
      />

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="font-medium text-sm text-text-primary">
            {t("editor.observationGroups", "Label groups")}
          </h3>
          <p className="mt-0.5 text-text-muted text-xs">
            {t(
              "editor.observationGroupsHint",
              "Each group is one question the agent answers with one of its labels. The labels must exist on the Chatwoot account. Up to {{max}} groups.",
              { max: lim.groupsMax },
            )}
          </p>
        </div>
        {observation.groups.length === 0 && (
          <p className="rounded-lg border border-border border-dashed px-3 py-2 text-text-muted text-xs">
            {t(
              "editor.observationOff",
              "No group yet: this agent reads and remembers, and classifies nothing.",
            )}
          </p>
        )}
        {observation.groups.map((g, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: groups have no identity of their own; the index is the row
            key={i}
            className="flex flex-col gap-3 rounded-lg border border-border p-3"
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <FormField
                label={t("editor.observationGroupName", "Group name")}
                description={t(
                  "editor.observationGroupNameHint",
                  "Also the key of the verdict in the logs.",
                )}
              >
                <Input
                  value={g.name}
                  placeholder="assunto"
                  onChange={(e) => patchGroup(i, { name: e.target.value })}
                />
              </FormField>
              <SwitchField
                className="pb-2"
                checked={g.exclusive}
                onCheckedChange={(v) => patchGroup(i, { exclusive: v })}
                label={t("editor.observationGroupExclusive", "One at a time")}
                help={t(
                  "editor.observationGroupExclusiveHelp",
                  "On: the verdict replaces the group's current label. Off: labels accumulate.",
                )}
              />
              <Button
                variant="secondary"
                size="sm"
                className="mb-1"
                aria-label={t(
                  "editor.observationRemoveGroup",
                  "Remove group {{name}}",
                  { name: g.name || String(i + 1) },
                )}
                onClick={() =>
                  setObservation((prev) => ({
                    ...prev,
                    groups: prev.groups.filter((_, j) => j !== i),
                  }))
                }
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <FormField
              label={t("editor.observationGroupValues", "Labels")}
              description={t(
                "editor.observationGroupValuesHint",
                "One per line, as titled on Chatwoot. Up to {{max}}.",
                { max: lim.valuesMax },
              )}
              error={
                groupIncomplete(g)
                  ? t(
                      "editor.observationGroupIncomplete",
                      "A group needs a name and at least one label; this one is not saved until it has both.",
                    )
                  : undefined
              }
            >
              <Textarea
                rows={4}
                maxLength={OBSERVATION_LIMITS.valuesTextMax}
                value={g.values}
                placeholder={"cancelamento\ncompra-de-ingresso\noutros"}
                onChange={(e) => patchGroup(i, { values: e.target.value })}
              />
            </FormField>
          </div>
        ))}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={atMax}
            onClick={() =>
              setObservation((prev) => ({
                ...prev,
                groups: [
                  ...prev.groups,
                  { name: "", exclusive: true, values: "" },
                ],
              }))
            }
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("editor.observationAddGroup", "Add group")}
          </Button>
        </div>
      </div>
    </Section>
  );
}
