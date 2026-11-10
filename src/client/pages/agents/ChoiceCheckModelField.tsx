import { useTranslation } from "react-i18next";
import { FormField } from "@/client/components";
import type { ChoiceCheckState } from "./choiceCheckFormState";
import { ModelOverrideFields } from "./ModelOverrideFields";
import {
  type AgentModelSource,
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
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
          <ModelOverrideFields
            value={value}
            onChange={onChange}
            parent={agentModel}
            credBaseUrl={credBaseUrl}
            credentialError={credentialError}
            sameAsLabel={t("editor.reviewSameAsAgent", "Same as the agent")}
            credentialHint={t(
              "editor.choiceCheck.credentialHint",
              "Required when the check uses another provider; without its own key, those tools are refused.",
            )}
            baseURLHint={t(
              "editor.reviewBaseURLHint",
              "Required for OpenAI-compatible endpoints, unless the credential already carries one.",
            )}
          />
        </fieldset>
      </FormField>
    </div>
  );
}
