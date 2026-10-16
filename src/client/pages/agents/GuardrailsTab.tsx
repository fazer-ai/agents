import {
  MessageCircle,
  Send,
  ShieldCheck,
  TriangleAlert,
  Webhook,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CredentialPicker,
  FormField,
  Input,
  ModelPicker,
  Select,
  SwitchField,
  Textarea,
} from "@/client/components";
import { credentialCompat } from "@/client/lib/credentialCompat";
import { providerLabel } from "@/client/lib/providerLabels";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import {
  CUSTOM_POLICY_MAX,
  GENERATION_PROMPT_MAX,
  TEMPLATE_MESSAGE_MAX,
} from "@/modules/agents/text-caps";
import {
  DECISION_PROVIDERS,
  DEFAULT_DECISION_MODEL,
  type DecisionProvider,
} from "@/modules/decisions/config";
import type {
  GuardrailAction,
  GuardrailChecks,
  GuardrailClassifier,
  GuardrailFailureMode,
  GuardrailsConfig,
  GuardrailThresholdKey,
} from "@/modules/guardrails/settings";
import { ExternalCheckContract } from "./ExternalCheckContract";
import { Section, SectionNav } from "./SectionNav";
import { TabActionBar } from "./TabActionBar";
import type { GuardrailsRefusals } from "./types";

// Agent editor "Guardrails" tab: input/output moderation (agent.settings.guardrails). Own Save +
// dirty tracking (its own SECTION_KEY). A dedicated LLM screens the customer message (input) and/or
// the agent reply (output); on a violation the configured per-direction action fires. The form state
// IS the config shape (GuardrailsConfig) — no separate form model needed.

interface GuardrailsTabProps {
  guardrails: GuardrailsConfig;
  setGuardrails: React.Dispatch<React.SetStateAction<GuardrailsConfig>>;
  // The refused input this tab draws, if the standing refusal is about one of them. Read in
  // AgentEditorPage and passed as answers -- see the note on the type.
  refusals: GuardrailsRefusals;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

// Product names, the same in every language (as on the Classifier card, DecisionsFields).
const DECISION_PROVIDER_NAMES: Record<DecisionProvider, string> = {
  openai: "OpenAI Decisions",
  typesafe: "TypeSafe (Jev)",
};

const ACTIONS: GuardrailAction[] = [
  "template",
  "generated",
  "silent",
  "handoff",
];

// A threshold field. Its text is the tab's draft for that check, shared by every field drawing the
// same threshold (a check on in both directions shows two), so typing in one shows in the other
// keystroke by keystroke: "0." is kept as typed, a value out of 0..1 is shown clamped as soon as it is
// typed, and leaving the field draws it again from the form, so what is shown is what will be saved.
function ThresholdInput({
  text,
  onType,
  onLeave,
  label,
  testId,
}: {
  text: string;
  onType: (raw: string) => void;
  onLeave: () => void;
  label: string;
  testId: string;
}) {
  return (
    <Input
      type="number"
      min={0}
      max={1}
      step={0.05}
      value={text}
      onChange={(e) => onType(e.target.value)}
      onBlur={onLeave}
      aria-label={label}
      data-testid={testId}
    />
  );
}

export function GuardrailsTab({
  guardrails: g,
  setGuardrails: setG,
  refusals,
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
    {
      id: "gr-external",
      icon: Webhook,
      label: t("editor.guardrails.navExternal", "External check"),
    },
  ];
  const setExternal = (patch: Partial<GuardrailsConfig["external"]>) =>
    setG((s) => ({ ...s, external: { ...s.external, ...patch } }));

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

  const byClassifier = g.classifier === "decisions";
  // Switching to a classification API takes `generated` off both directions, since no model writes
  // the replacement there: the screen shows the action that will run instead of saving one the
  // server refuses. Switching back leaves the template, and `generated` can be picked again.
  const setClassifier = (classifier: GuardrailClassifier) =>
    setG((s) => ({
      ...s,
      classifier,
      ...(classifier === "decisions"
        ? {
            input:
              s.input.action === "generated"
                ? { ...s.input, action: "template" }
                : s.input,
            output:
              s.output.action === "generated"
                ? { ...s.output, action: "template" }
                : s.output,
          }
        : {}),
    }));
  const setDecisions = (patch: Partial<GuardrailsConfig["decisions"]>) =>
    setG((s) => ({ ...s, decisions: { ...s.decisions, ...patch } }));
  // Typed text per threshold, while a field for it is being edited: one draft per check, so the
  // check's field in Input and its field in Output always show the same text.
  const [thresholdDrafts, setThresholdDrafts] = useState<
    Partial<Record<GuardrailThresholdKey, string>>
  >({});
  const typeThreshold = (key: GuardrailThresholdKey, raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) {
      setThresholdDrafts((d) => ({ ...d, [key]: raw }));
      return;
    }
    const clamped = Math.min(Math.max(n, 0), 1);
    setThresholdDrafts((d) => ({
      ...d,
      [key]: clamped === n ? raw : String(clamped),
    }));
    setG((s) => ({
      ...s,
      decisions: {
        ...s.decisions,
        thresholds: { ...s.decisions.thresholds, [key]: clamped },
      },
    }));
  };
  const leaveThreshold = (key: GuardrailThresholdKey) =>
    setThresholdDrafts(({ [key]: _left, ...rest }) => rest);
  const checkLabel = (k: keyof GuardrailChecks) =>
    ({
      toxicity: t("editor.guardrails.checkToxicity", "Toxicity / abuse"),
      unsafeContent: t("editor.guardrails.checkUnsafe", "Unsafe content"),
      competitorMentions: t(
        "editor.guardrails.checkCompetitors",
        "Competitor mentions",
      ),
      promptAdherence: t(
        "editor.guardrails.checkAdherence",
        "Adherence to the agent's instructions",
      ),
      answerRelevance: t(
        "editor.guardrails.checkRelevance",
        "The reply answers what the customer asked",
      ),
    })[k];
  const thresholdInput = (key: GuardrailThresholdKey, label: string) => (
    <ThresholdInput
      text={thresholdDrafts[key] ?? String(g.decisions.thresholds[key])}
      onType={(raw) => typeThreshold(key, raw)}
      onLeave={() => leaveThreshold(key)}
      label={label}
      testId={`gr-threshold-${key}`}
    />
  );

  const actionLabel = (a: GuardrailAction) =>
    a === "template"
      ? t("editor.guardrails.actionTemplate", "Reply with a template message")
      : a === "generated"
        ? t(
            "editor.guardrails.actionGenerated",
            "Reply with a guardrails-generated message",
          )
        : a === "handoff"
          ? t(
              "editor.guardrails.actionHandoff",
              "Hand the conversation to the team",
            )
          : t(
              "editor.guardrails.actionSilent",
              "Send nothing (leave the customer without a reply)",
            );

  // A check's switch, and beside it the check's threshold when a classification API judges and the
  // check is on in this direction. The threshold belongs to the check, not to the direction: a check
  // on in both directions draws the same value twice, and editing either edits both.
  const checkRow = (
    dir: "input" | "output",
    key: keyof GuardrailChecks,
    help?: string,
  ) => {
    const on = g[dir].checks[key];
    return (
      <div className="flex items-center gap-3">
        <div className="min-w-0 grow">
          <SwitchField
            checked={on}
            onCheckedChange={(v) => setCheck(dir, key, v)}
            label={checkLabel(key)}
            help={help}
          />
        </div>
        {byClassifier && on && (
          <div className="w-24 shrink-0">
            {thresholdInput(
              key,
              t("editor.guardrails.checkThreshold", "Threshold: {{check}}", {
                check: checkLabel(key),
              }),
            )}
          </div>
        )}
      </div>
    );
  };

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
            <FormField
              label={t("editor.guardrails.checks", "Checks")}
              description={
                byClassifier
                  ? t(
                      "editor.guardrails.thresholdsHint",
                      "The number beside each check is its threshold, from 0 to 1: the check trips when the API's probability reaches it. Lower blocks more; higher lets more through.",
                    )
                  : undefined
              }
              group
            >
              <div className="flex flex-col gap-2">
                {checkRow(dir, "toxicity")}
                {checkRow(dir, "unsafeContent")}
                {checkRow(dir, "competitorMentions")}
                {dir === "output" && (
                  <>
                    {checkRow(dir, "promptAdherence")}
                    {checkRow(
                      dir,
                      "answerRelevance",
                      t(
                        "editor.guardrails.checkRelevanceHelp",
                        "This check determines whether the agent's reply addresses the customer's message.\n\nIf it fails, the configured action always uses the prepared message. The model does not write a replacement reply.\n\nIt is off by default because short messages such as “yes” can cause false failures. When another check is active, each reply makes two separately billed model requests.",
                      ),
                    )}
                  </>
                )}
              </div>
            </FormField>
          </>
        )}
        {/* The action and its messages are also what the external check's block and a held failure
            use, so they stay editable while it is configured, built-in screening on or off. */}
        {(d.enabled || (dir === "output" && !!g.external.url)) && (
          <>
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
                  <option
                    key={a}
                    value={a}
                    disabled={a === "generated" && byClassifier}
                  >
                    {a === "generated" && byClassifier
                      ? t(
                          "editor.guardrails.actionGeneratedUnavailable",
                          "{{action}} (not available with a classification API)",
                          { action: actionLabel(a) },
                        )
                      : actionLabel(a)}
                  </option>
                ))}
              </Select>
            </FormField>
            {/* Shown for "generated" too, because that action falls back to this text whenever no
                replacement is written: when the model returns none, and always when the relevance
                check is what tripped. It is the message customers actually receive then. */}
            {/* The hand-over's own sentence. Not the template: that one is a refusal, and this says
                a person will continue. Empty is a choice, so the box may be left blank on purpose.
                Shown under hold too, where a check that cannot run sends it. */}
            {(d.action === "handoff" || g.onFailure === "hold") && (
              <FormField
                label={t(
                  "editor.guardrails.handoffMessage",
                  "Message to the customer",
                )}
                description={t(
                  "editor.guardrails.handoffMessageHint",
                  "Sent when the case goes to the team. Leave it empty to hand over without writing to the customer.",
                )}
                error={
                  dir === "input"
                    ? refusals.inputHandoffMessage
                    : refusals.outputHandoffMessage
                }
              >
                <Textarea
                  value={d.handoffMessage}
                  onChange={(e) =>
                    setDir(dir, { handoffMessage: e.target.value })
                  }
                  rows={2}
                  maxLength={TEMPLATE_MESSAGE_MAX}
                />
              </FormField>
            )}
            {d.action !== "silent" && d.action !== "handoff" && (
              <FormField
                label={t("editor.guardrails.template", "Template message")}
                error={
                  dir === "input"
                    ? refusals.inputTemplateMessage
                    : refusals.outputTemplateMessage
                }
                // The two directions say different KINDS of thing about the same box, so they take
                // different homes. Outbound is one sentence about when this text is used, which is
                // what the operator needs to fill the field: inline. Inbound is why the field can
                // never be anything else, read once: behind the `?`. It matters here more than
                // elsewhere that the inbound text is not inline, because this field renders an
                // `error` in the same slot, so a refusal would erase the explanation of the rule
                // it just enforced.
                description={
                  d.action === "generated" && dir === "output"
                    ? t(
                        "editor.guardrails.templateFallbackHint",
                        "Sent whenever no replacement gets written: when the model returns none, and always when the relevance check is the one that tripped, since there is no reply to rewrite.",
                      )
                    : undefined
                }
                help={
                  d.action === "generated" && dir === "input"
                    ? t(
                        "editor.guardrails.templateInboundHelp",
                        "On customer messages, this text is ALWAYS what gets sent.\n\nThere is no reply to rewrite: the text under review is the customer's own message.\n\nThis was measured: a message telling it to state a price and a partnership produced exactly that, word for word, in all 16 runs.",
                      )
                    : undefined
                }
              >
                <Textarea
                  value={d.templateMessage}
                  onChange={(e) =>
                    setDir(dir, { templateMessage: e.target.value })
                  }
                  rows={2}
                  maxLength={TEMPLATE_MESSAGE_MAX}
                />
              </FormField>
            )}
            {/* Output only. On the customer's message nothing is ever composed, so this field
                would steer nothing — and a control that visibly does nothing is worse than one that
                is not offered. The template hint above says why, where the operator is looking. */}
            {d.action === "generated" && dir === "output" && (
              <FormField
                label={t(
                  "editor.guardrails.generationPrompt",
                  "Generation guidance",
                )}
                description={t(
                  "editor.guardrails.generationPromptHint",
                  "Steers how the guardrails agent writes the replacement reply (tone, what to offer or avoid). Optional.",
                )}
                error={refusals.outputGenerationPrompt}
              >
                <Textarea
                  value={d.generationPrompt}
                  onChange={(e) =>
                    setDir(dir, { generationPrompt: e.target.value })
                  }
                  rows={3}
                  maxLength={GENERATION_PROMPT_MAX}
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
              <FormField
                label={t("editor.guardrails.classifier", "Who judges")}
                description={
                  byClassifier
                    ? t(
                        "editor.guardrails.classifierDecisionsHint",
                        "A classification API answers one yes/no question per check. Faster, but it gives only numbers and writes no reply.",
                      )
                    : t(
                        "editor.guardrails.classifierChatHint",
                        "A language model reads the message and explains its verdict. It can write a replacement reply.",
                      )
                }
                help={
                  byClassifier
                    ? t(
                        "editor.guardrails.classifierDecisionsHelp",
                        "Each enabled check, and the custom policy, is one yes/no question to the classification API.\n\nA check trips when its probability reaches its threshold.\n\nThe API writes no reply of its own, so the generated reply action is not available: a tripped message gets the template or is silenced.",
                      )
                    : undefined
                }
              >
                <Select
                  value={g.classifier}
                  onChange={(e) =>
                    setClassifier(e.target.value as GuardrailClassifier)
                  }
                  data-testid="gr-classifier"
                >
                  <option value="chat">
                    {t(
                      "editor.guardrails.classifierChat",
                      "A language model (default)",
                    )}
                  </option>
                  <option value="decisions">
                    {t(
                      "editor.guardrails.classifierDecisions",
                      "A classification API (Jev, OpenAI Decisions)",
                    )}
                  </option>
                </Select>
              </FormField>
            )}
            {g.enabled && (
              <FormField
                label={t(
                  "editor.guardrails.onFailure",
                  "When a check cannot run",
                )}
                description={
                  g.onFailure === "hold"
                    ? t(
                        "editor.guardrails.onFailureHoldHint",
                        "The message is stopped and the conversation goes to your team, with the direction's handoff message. Follow-ups the agent starts on its own still go out.",
                      )
                    : t(
                        "editor.guardrails.onFailurePassHint",
                        "The message continues unchecked, and the Logs page records that the check failed.",
                      )
                }
              >
                <Select
                  value={g.onFailure}
                  onChange={(e) =>
                    setG((s) => ({
                      ...s,
                      onFailure: e.target.value as GuardrailFailureMode,
                    }))
                  }
                  data-testid="gr-on-failure"
                >
                  <option value="pass">
                    {t(
                      "editor.guardrails.onFailurePass",
                      "Let the message through (default)",
                    )}
                  </option>
                  <option value="hold">
                    {t(
                      "editor.guardrails.onFailureHold",
                      "Hold it and hand the conversation to the team",
                    )}
                  </option>
                </Select>
              </FormField>
            )}
            {g.enabled && byClassifier && (
              <>
                <FormField
                  label={t(
                    "editor.guardrails.decisionsProvider",
                    "Classification API",
                  )}
                >
                  <Select
                    value={g.decisions.provider}
                    onChange={(e) => {
                      const provider = e.target.value as DecisionProvider;
                      setDecisions({
                        provider,
                        model: DEFAULT_DECISION_MODEL[provider],
                      });
                    }}
                    data-testid="gr-decisions-provider"
                  >
                    {DECISION_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {DECISION_PROVIDER_NAMES[p]}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label={t("editor.credential", "API key")}
                  error={refusals.decisionsCredential}
                  group
                >
                  <CredentialPicker
                    value={g.decisions.credentialRef ?? ""}
                    onChange={(v) => setDecisions({ credentialRef: v || null })}
                    required
                    compatibleTypes={credentialCompat.decisions(
                      g.decisions.provider,
                    )}
                    defaultCreateType={
                      credentialCompat.decisions(g.decisions.provider)[0]
                    }
                    ariaLabel={t("editor.credential", "API key")}
                  />
                </FormField>
                <FormField
                  label={t("editor.model", "Model")}
                  description={t(
                    "editor.guardrails.decisionsModelHint",
                    "Empty uses the default, {{model}}.",
                    { model: DEFAULT_DECISION_MODEL[g.decisions.provider] },
                  )}
                >
                  <Input
                    value={g.decisions.model}
                    onChange={(e) => setDecisions({ model: e.target.value })}
                    placeholder={DEFAULT_DECISION_MODEL[g.decisions.provider]}
                  />
                </FormField>
              </>
            )}
            {g.enabled && !byClassifier && (
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
                <FormField
                  label={t("editor.credential", "API key")}
                  error={refusals.credential}
                  group
                >
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
                  {/* biome-ignore lint/plugin/require-textarea-cap: bounded by entry count and per-entry length, so a dropped entry shows as a missing row, not a sentence that ends early */}
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
                  error={refusals.customPolicy}
                  description={
                    byClassifier
                      ? t(
                          "editor.guardrails.customPolicyQuestionHint",
                          "Write it as one yes/no question where yes means a violation.",
                        )
                      : t(
                          "editor.guardrails.customPolicyHint",
                          "Extra rules appended to every analysis.",
                        )
                  }
                  help={
                    byClassifier
                      ? t(
                          "editor.guardrails.customPolicyQuestionHelp",
                          "For example: “Does the reply promise the customer a refund?”\n\nA rule written as a statement (“the assistant must not…”) is read the wrong way round, and clean replies trip it.",
                        )
                      : undefined
                  }
                >
                  <Textarea
                    value={g.customPolicy}
                    onChange={(e) =>
                      setG((s) => ({ ...s, customPolicy: e.target.value }))
                    }
                    rows={3}
                    maxLength={CUSTOM_POLICY_MAX}
                  />
                </FormField>
                {byClassifier && g.customPolicy.trim() && (
                  <FormField
                    label={t(
                      "editor.guardrails.customPolicyThreshold",
                      "Threshold for the custom policy",
                    )}
                    description={t(
                      "editor.guardrails.customPolicyThresholdHint",
                      "From 0 to 1, like the checks' thresholds.",
                    )}
                  >
                    {thresholdInput(
                      "customPolicy",
                      t(
                        "editor.guardrails.customPolicyThreshold",
                        "Threshold for the custom policy",
                      ),
                    )}
                  </FormField>
                )}
              </Section>
              <Section
                id="gr-external"
                icon={Webhook}
                title={t("editor.guardrails.external", "External check")}
                description={t(
                  "editor.guardrails.externalDesc",
                  "Before a reply to a customer is delivered, it is sent to your endpoint with the turn's messages and tool calls, and your endpoint answers allow, replace or block. A block uses the Output action; no answer within 15 s follows “When a check cannot run”.",
                )}
              >
                <div>
                  <ExternalCheckContract />
                </div>
                <FormField
                  label={t("editor.guardrails.externalUrl", "Endpoint URL")}
                  error={refusals.externalUrl}
                  description={t(
                    "editor.guardrails.externalUrlHint",
                    "https only. Empty turns the external check off.",
                  )}
                >
                  <Input
                    value={g.external.url ?? ""}
                    onChange={(e) =>
                      setExternal({ url: e.target.value.trim() || null })
                    }
                    placeholder="https://"
                    data-testid="gr-external-url"
                  />
                </FormField>
                <FormField
                  label={t(
                    "editor.guardrails.externalSecret",
                    "Signing secret",
                  )}
                  error={refusals.externalSecret}
                  description={t(
                    "editor.guardrails.externalSecretHint",
                    "Signs each request with HMAC-SHA256, like the outbound webhooks. Empty sends it unsigned.",
                  )}
                  group
                >
                  <CredentialPicker
                    value={g.external.credentialRef ?? ""}
                    onChange={(v) => setExternal({ credentialRef: v || null })}
                    ariaLabel={t(
                      "editor.guardrails.externalSecret",
                      "Signing secret",
                    )}
                  />
                </FormField>
                <SwitchField
                  checked={g.external.sendToolValues}
                  onCheckedChange={(v) => setExternal({ sendToolValues: v })}
                  label={t(
                    "editor.guardrails.externalToolValues",
                    "Send tool values",
                  )}
                  help={t(
                    "editor.guardrails.externalToolValuesHint",
                    "Off sends each tool call's name and sizes, without its arguments and result.",
                  )}
                />
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
