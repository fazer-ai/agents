import { ShieldCheck } from "lucide-react";
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
import { KnowledgeGrantsEditor } from "./KnowledgeGrantsEditor";
import type { SuggestionReviewState } from "./knowledgeFormState";
import {
  type AgentModelSource,
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
  overrideNeedsOwnCredential,
  overridePicked,
  overridePickerSource,
  overrideProviderChanged,
} from "./modelOverrideForm";
import { Section } from "./SectionNav";
import { TabActionBar } from "./TabActionBar";
import type { GrantState, ToolCatalog } from "./types";

interface KnowledgeTabProps {
  catalog: ToolCatalog;
  grants: GrantState[];
  onChange: React.Dispatch<React.SetStateAction<GrantState[]>>;
  onCatalogChange: () => void | Promise<void>;
  review: SuggestionReviewState;
  setReview: React.Dispatch<React.SetStateAction<SuggestionReviewState>>;
  // The SAVED model and its effective endpoint, which the reviewer inherits field by field.
  agentModel: AgentModelSource;
  // The endpoint the reviewer's own credential carries, which outranks the typed field.
  reviewCredBaseUrl: string | null;
  reviewCredentialError?: string;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  // Absent for a WATCHER, for the reason ToolsTab states.
  onOpenPlayground?: () => void;
}

export function KnowledgeTab({
  catalog,
  grants,
  onChange,
  onCatalogChange,
  review,
  setReview,
  agentModel,
  reviewCredBaseUrl,
  reviewCredentialError,
  dirty,
  saving,
  onSave,
  onDiscard,
  onOpenPlayground,
}: KnowledgeTabProps) {
  const { t } = useTranslation();
  const source = overridePickerSource(review, agentModel, reviewCredBaseUrl);
  const effectiveProvider = review.provider || agentModel.provider;
  const needsOwnCredential = overrideNeedsOwnCredential(
    review,
    agentModel,
    reviewCredBaseUrl,
  );
  const baseUrlInvalid = overrideBaseUrlInvalid(
    review,
    agentModel,
    reviewCredBaseUrl,
    true,
  );
  const baseUrlUnsupported = overrideBaseUrlUnsupported(
    review,
    agentModel,
    reviewCredBaseUrl,
    true,
  );
  const sameAsAgent = t("editor.reviewSameAsAgent", "Same as the agent");

  return (
    <div className="flex grow flex-col gap-4">
      <KnowledgeGrantsEditor
        catalog={catalog}
        grants={grants}
        onChange={onChange}
        onCatalogChange={onCatalogChange}
      />
      <Section
        id="kb-review"
        icon={ShieldCheck}
        title={t("editor.reviewModel", "Suggestion reviewer")}
        help={t(
          "editor.reviewModelHelp",
          "Before a suggestion from this agent reaches the approval queue, a model compares it with what the knowledge base, the queue and earlier rejections already hold.\n\nA repeat goes to the Discarded tab of Approvals, with what it matched; a correction of an existing document comes with that document to replace. Nothing is ever lost: if the review fails, the suggestion goes to the queue unreviewed.\n\nBy default it runs on the agent's own model.",
        )}
      >
        <FormField label={t("editor.provider", "Provider")}>
          <Select
            value={review.provider}
            onChange={(e) =>
              setReview((prev) => overrideProviderChanged(prev, e.target.value))
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
          error={reviewCredentialError}
          description={t(
            "editor.reviewCredentialHint",
            "Required when the reviewer uses another provider; without its own key, suggestions reach the queue unreviewed.",
          )}
          group
        >
          <CredentialPicker
            value={review.credentialRef}
            onChange={(v) =>
              setReview((prev) =>
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
            value={review.model}
            onChange={(v) =>
              setReview((prev) =>
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
          !!reviewCredBaseUrl ||
          !!review.baseURL.trim()) && (
          <FormField
            label={t("editor.baseURL", "Base URL")}
            description={
              reviewCredBaseUrl
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
                : baseUrlInvalid && review.baseURL.trim()
                  ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                  : null
            }
          >
            <Input
              value={reviewCredBaseUrl ?? review.baseURL}
              onChange={(e) =>
                setReview((prev) => ({ ...prev, baseURL: e.target.value }))
              }
              disabled={!!reviewCredBaseUrl}
              placeholder="https://api.groq.com/openai/v1"
            />
          </FormField>
        )}
      </Section>
      <TabActionBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
        saveLabel={t("editor.saveKnowledge", "Save knowledge")}
        onOpenPlayground={onOpenPlayground}
        saveDisabled={baseUrlInvalid || baseUrlUnsupported}
      />
    </div>
  );
}
