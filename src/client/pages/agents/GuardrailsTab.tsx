import { MessageCircle, Send, ShieldCheck, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  CredentialPicker,
  FormField,
  ModelPicker,
  Select,
  SwitchField,
  Textarea,
} from "@/client/components";
import { credentialCompat } from "@/client/lib/credentialCompat";
import { providerLabel } from "@/client/lib/providerLabels";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import type {
  GuardrailAction,
  GuardrailChecks,
  GuardrailsConfig,
} from "@/modules/guardrails/settings";
import { MODEL_PROVIDERS } from "./GeneralTab";
import { Section, SectionNav } from "./SectionNav";
import { TabActionBar } from "./TabActionBar";

// Agent editor "Guardrails" tab: input/output moderation (agent.settings.guardrails). Own Save +
// dirty tracking (its own SECTION_KEY). A dedicated LLM screens the customer message (input) and/or
// the agent reply (output); on a violation the configured per-direction action fires. The form state
// IS the config shape (GuardrailsConfig) — no separate form model needed.

interface GuardrailsTabProps {
  guardrails: GuardrailsConfig;
  setGuardrails: React.Dispatch<React.SetStateAction<GuardrailsConfig>>;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

const ACTIONS: GuardrailAction[] = ["template", "generated", "silent"];

export function GuardrailsTab({
  guardrails: g,
  setGuardrails: setG,
  dirty,
  saving,
  onSave,
  onDiscard,
}: GuardrailsTabProps) {
  const { t } = useTranslation();

  const sections = [
    {
      id: "gr-model",
      icon: ShieldCheck,
      label: t("editor.guardrails.navModel", "Model"),
    },
    {
      id: "gr-input",
      icon: MessageCircle,
      label: t("editor.guardrails.navInput", "Input"),
    },
    {
      id: "gr-output",
      icon: Send,
      label: t("editor.guardrails.navOutput", "Output"),
    },
    {
      id: "gr-policy",
      icon: TriangleAlert,
      label: t("editor.guardrails.navPolicy", "Policy"),
    },
  ];

  const setDir = (
    dir: "input" | "output",
    patch: Partial<GuardrailsConfig["input"]>,
  ) => setG((s) => ({ ...s, [dir]: { ...s[dir], ...patch } }));
  const setCheck = (
    dir: "input" | "output",
    key: keyof GuardrailChecks,
    v: boolean,
  ) =>
    setG((s) => ({
      ...s,
      [dir]: { ...s[dir], checks: { ...s[dir].checks, [key]: v } },
    }));

  const actionLabel = (a: GuardrailAction) =>
    a === "template"
      ? t("editor.guardrails.actionTemplate", "Reply with a template message")
      : a === "generated"
        ? t(
            "editor.guardrails.actionGenerated",
            "Reply with a guardrails-generated message",
          )
        : t(
            "editor.guardrails.actionSilent",
            "Send nothing (leave the customer without a reply)",
          );

  const renderDirection = (dir: "input" | "output") => {
    const d = g[dir];
    return (
      <>
        <SwitchField
          checked={d.enabled}
          onCheckedChange={(v) => setDir(dir, { enabled: v })}
          label={t("editor.guardrails.directionEnabled", "Enable")}
        />
        {d.enabled && (
          <>
            <FormField label={t("editor.guardrails.checks", "Checks")} group>
              <div className="flex flex-col gap-2">
                <SwitchField
                  checked={d.checks.toxicity}
                  onCheckedChange={(v) => setCheck(dir, "toxicity", v)}
                  label={t(
                    "editor.guardrails.checkToxicity",
                    "Toxicity / abuse",
                  )}
                />
                <SwitchField
                  checked={d.checks.unsafeContent}
                  onCheckedChange={(v) => setCheck(dir, "unsafeContent", v)}
                  label={t("editor.guardrails.checkUnsafe", "Unsafe content")}
                />
                <SwitchField
                  checked={d.checks.competitorMentions}
                  onCheckedChange={(v) =>
                    setCheck(dir, "competitorMentions", v)
                  }
                  label={t(
                    "editor.guardrails.checkCompetitors",
                    "Competitor mentions",
                  )}
                />
                {dir === "output" && (
                  <SwitchField
                    checked={d.checks.promptAdherence}
                    onCheckedChange={(v) => setCheck(dir, "promptAdherence", v)}
                    label={t(
                      "editor.guardrails.checkAdherence",
                      "Adherence to the agent's instructions",
                    )}
                  />
                )}
              </div>
            </FormField>
            <FormField
              label={t("editor.guardrails.action", "On violation")}
              description={t(
                "editor.guardrails.actionHint",
                "What to do when a check trips.",
              )}
            >
              <Select
                value={d.action}
                onChange={(e) =>
                  setDir(dir, { action: e.target.value as GuardrailAction })
                }
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {actionLabel(a)}
                  </option>
                ))}
              </Select>
            </FormField>
            {d.action === "template" && (
              <FormField
                label={t("editor.guardrails.template", "Template message")}
              >
                <Textarea
                  value={d.templateMessage}
                  onChange={(e) =>
                    setDir(dir, { templateMessage: e.target.value })
                  }
                  rows={2}
                />
              </FormField>
            )}
            {d.action === "generated" && (
              <FormField
                label={t(
                  "editor.guardrails.generationPrompt",
                  "Generation guidance",
                )}
                description={t(
                  "editor.guardrails.generationPromptHint",
                  "Steers how the guardrails agent writes the replacement reply (tone, what to offer or avoid). Optional.",
                )}
              >
                <Textarea
                  value={d.generationPrompt}
                  onChange={(e) =>
                    setDir(dir, { generationPrompt: e.target.value })
                  }
                  rows={3}
                  placeholder={t(
                    "editor.guardrails.generationPromptPlaceholder",
                    "e.g. Politely decline, keep a warm tone, and offer to connect them with a human agent.",
                  )}
                />
              </FormField>
            )}
          </>
        )}
      </>
    );
  };

  return (
    <div className="flex grow flex-col gap-4">
      <div className="flex gap-6">
        <SectionNav sections={sections} />
        <div className="flex min-w-0 grow flex-col gap-4">
          <Section
            id="gr-model"
            icon={ShieldCheck}
            title={t("editor.guardrails.model", "Guardrails model")}
            description={t(
              "editor.guardrails.modelDesc",
              "A dedicated moderation agent screens messages. Off by default; pick a model + API key.",
            )}
          >
            <SwitchField
              checked={g.enabled}
              onCheckedChange={(v) => setG((s) => ({ ...s, enabled: v }))}
              label={t("editor.guardrails.enabled", "Enable guardrails")}
            />
            {g.enabled && (
              <>
                <FormField label={t("editor.provider", "Provider")}>
                  <Select
                    value={g.provider}
                    onChange={(e) => {
                      const provider = e.target.value;
                      setG((s) => ({
                        ...s,
                        provider: provider as GuardrailsConfig["provider"],
                        model: PROVIDER_DEFAULT_MODEL[provider] ?? "",
                      }));
                    }}
                  >
                    {MODEL_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {providerLabel(p, t)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label={t("editor.credential", "API key")} group>
                  <CredentialPicker
                    value={g.credentialRef ?? ""}
                    onChange={(v) =>
                      setG((s) => ({ ...s, credentialRef: v || null }))
                    }
                    required={g.provider !== "openai-compatible"}
                    compatibleTypes={credentialCompat.model(g.provider)}
                    defaultCreateType={credentialCompat.model(g.provider)[0]}
                    ariaLabel={t("editor.credential", "API key")}
                  />
                </FormField>
                <FormField label={t("editor.model", "Model")} group>
                  <ModelPicker
                    value={g.model}
                    onChange={(v) => setG((s) => ({ ...s, model: v }))}
                    provider={g.provider}
                    credentialRef={g.credentialRef || undefined}
                    baseURL={g.baseURL || undefined}
                    aria-label={t("editor.model", "Model")}
                  />
                </FormField>
              </>
            )}
          </Section>

          {g.enabled && (
            <>
              <Section
                id="gr-input"
                icon={MessageCircle}
                title={t("editor.guardrails.input", "Input (customer message)")}
                description={t(
                  "editor.guardrails.inputDesc",
                  "Screen the customer's message before the agent processes it.",
                )}
              >
                {renderDirection("input")}
              </Section>
              <Section
                id="gr-output"
                icon={Send}
                title={t("editor.guardrails.output", "Output (agent reply)")}
                description={t(
                  "editor.guardrails.outputDesc",
                  "Screen the agent's reply before it is sent.",
                )}
              >
                {renderDirection("output")}
              </Section>
              <Section
                id="gr-policy"
                icon={TriangleAlert}
                title={t("editor.guardrails.policy", "Policy")}
                description={t(
                  "editor.guardrails.policyDesc",
                  "Competitor list and extra instructions used by the checks.",
                )}
              >
                <FormField
                  label={t("editor.guardrails.competitors", "Competitors")}
                  description={t(
                    "editor.guardrails.competitorsHint",
                    "One per line. Used by the competitor-mentions check.",
                  )}
                >
                  <Textarea
                    value={g.competitors.join("\n")}
                    onChange={(e) =>
                      setG((s) => ({
                        ...s,
                        competitors: e.target.value.split("\n"),
                      }))
                    }
                    rows={3}
                  />
                </FormField>
                <FormField
                  label={t("editor.guardrails.customPolicy", "Custom policy")}
                  description={t(
                    "editor.guardrails.customPolicyHint",
                    "Extra rules appended to every analysis.",
                  )}
                >
                  <Textarea
                    value={g.customPolicy}
                    onChange={(e) =>
                      setG((s) => ({ ...s, customPolicy: e.target.value }))
                    }
                    rows={3}
                  />
                </FormField>
              </Section>
            </>
          )}
        </div>
      </div>
      <TabActionBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
      />
    </div>
  );
}
