import { useTranslation } from "react-i18next";
import {
  CredentialPicker,
  FormField,
  Input,
  ModelPicker,
  Select,
} from "@/client/components";
import { credentialCompat } from "@/client/lib/credentialCompat";
import { providerLabel } from "@/client/lib/providerLabels";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import type { ChoiceCheckState } from "./choiceCheckFormState";
import {
  type AgentModelSource,
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
  overrideNeedsOwnCredential,
  overridePicked,
  overridePickerSource,
  overrideProviderChanged,
} from "./modelOverrideForm";

// Whether the judge's fields hold the Tools save: the same two endpoint checks the reviewer's card
// runs, asked only while the card is drawn.
export function choiceCheckBlocksSave(
  value: ChoiceCheckState,
  agentModel: AgentModelSource,
  credBaseUrl: string | null,
  shown: boolean,
): boolean {
  return (
    overrideBaseUrlInvalid(value, agentModel, credBaseUrl, shown) ||
    overrideBaseUrlUnsupported(value, agentModel, credBaseUrl, shown)
  );
}

interface ChoiceCheckModelFieldProps {
  value: ChoiceCheckState;
  onChange: React.Dispatch<React.SetStateAction<ChoiceCheckState>>;
  // The SAVED model and its effective endpoint, which the judge inherits field by field.
  agentModel: AgentModelSource;
  // The endpoint the judge's own credential carries, which outranks the typed field.
  credBaseUrl: string | null;
  credentialError?: string;
  saving: boolean;
}

export function ChoiceCheckModelField({
  value,
  onChange,
  agentModel,
  credBaseUrl,
  credentialError,
  saving,
}: ChoiceCheckModelFieldProps) {
  const { t } = useTranslation();
  const source = overridePickerSource(value, agentModel, credBaseUrl);
  const effectiveProvider = value.provider || agentModel.provider;
  const needsOwnCredential = overrideNeedsOwnCredential(
    value,
    agentModel,
    credBaseUrl,
  );
  const baseUrlInvalid = overrideBaseUrlInvalid(
    value,
    agentModel,
    credBaseUrl,
    true,
  );
  const baseUrlUnsupported = overrideBaseUrlUnsupported(
    value,
    agentModel,
    credBaseUrl,
    true,
  );
  const sameAsAgent = t("editor.reviewSameAsAgent", "Same as the agent");
  return (
    <div className="flex flex-col gap-3" id="tools-choice-check">
      <FormField
        group
        label={t("editor.choiceCheck.title", "Choice check model")}
        description={t(
          "editor.choiceCheck.help",
          "The model that checks, before a tool that requires the customer's choice runs, that the customer chose every value of the call. By default it is the agent's own model. If the model set here cannot run, those tools are refused.",
        )}
      >
        {/* Locked while the tab saves, like the reviewer's: an edit made meanwhile would be marked
        saved and never sent. */}
        <fieldset disabled={saving} className="contents">
          <FormField label={t("editor.provider", "Provider")}>
            <Select
              value={value.provider}
              onChange={(e) =>
                onChange((prev) =>
                  overrideProviderChanged(prev, e.target.value),
                )
              }
            >
              <option value="">{sameAsAgent}</option>
              {MODEL_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p, t)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label={t("editor.credential", "API key")}
            error={credentialError}
            description={t(
              "editor.choiceCheck.credentialHint",
              "Required when the check uses another provider; without its own key, those tools are refused.",
            )}
            group
          >
            <CredentialPicker
              value={value.credentialRef}
              onChange={(v) =>
                onChange((prev) =>
                  overridePicked(prev, "credentialRef", v, agentModel.provider),
                )
              }
              required={needsOwnCredential}
              compatibleTypes={credentialCompat.model(effectiveProvider)}
              defaultCreateType={credentialCompat.model(effectiveProvider)[0]}
              ariaLabel={t("editor.credential", "API key")}
            />
          </FormField>
          <FormField label={t("editor.model", "Model")} group>
            <ModelPicker
              value={value.model}
              onChange={(v) =>
                onChange((prev) =>
                  overridePicked(prev, "model", v, agentModel.provider),
                )
              }
              provider={effectiveProvider}
              credentialRef={source.credentialRef || undefined}
              baseURL={source.baseURL || undefined}
              placeholder={
                effectiveProvider === agentModel.provider
                  ? sameAsAgent
                  : undefined
              }
            />
          </FormField>
          {(effectiveProvider === "openai-compatible" ||
            !!credBaseUrl ||
            !!value.baseURL.trim()) && (
            <FormField
              label={t("editor.baseURL", "Base URL")}
              description={
                credBaseUrl
                  ? t(
                      "editor.baseURLFromCredential",
                      "Defined by the selected credential.",
                    )
                  : t(
                      "editor.reviewBaseURLHint",
                      "Required for OpenAI-compatible endpoints, unless the credential already carries one.",
                    )
              }
              error={
                baseUrlUnsupported
                  ? t(
                      "editor.baseURLNotSentByProvider",
                      "This provider does not send a base URL: the request would go to its own endpoint instead. Pick a credential without one, or use an OpenAI-compatible provider.",
                    )
                  : baseUrlInvalid && value.baseURL.trim()
                    ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                    : null
              }
            >
              <Input
                value={credBaseUrl ?? value.baseURL}
                onChange={(e) =>
                  onChange((prev) => ({ ...prev, baseURL: e.target.value }))
                }
                disabled={!!credBaseUrl}
                placeholder="https://api.groq.com/openai/v1"
              />
            </FormField>
          )}
        </fieldset>
      </FormField>
    </div>
  );
}
