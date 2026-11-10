import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { KnowledgeGrantsEditor } from "./KnowledgeGrantsEditor";
import type { SuggestionReviewState } from "./knowledgeFormState";
import { ModelOverrideFields } from "./ModelOverrideFields";
import {
  type AgentModelSource,
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
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
  // False on a voice agent: a call never suggests an entry, so the reviewer has nothing to judge.
  suggestions?: boolean;
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
  suggestions = true,
}: KnowledgeTabProps) {
  const { t } = useTranslation();
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
      {suggestions && (
        <Section
          id="kb-review"
          icon={ShieldCheck}
          title={t("editor.reviewModel", "Suggestion reviewer")}
          help={t(
            "editor.reviewModelHelp",
            "Before a suggestion from this agent reaches the approval queue, a model compares it with what the knowledge base, the queue and earlier rejections already hold.\n\nA repeat goes to the Discarded tab of Approvals, with what it matched; a correction of an existing document comes with that document to replace. Nothing is ever lost: if the review fails, the suggestion goes to the queue unreviewed.\n\nBy default it runs on the agent's own model.",
          )}
        >
          {/* Locked while the tab saves: the save decides whether to write the reviewer from the values
          it read when it started, so an edit made meanwhile would be marked saved and never sent. */}
          <fieldset disabled={saving} className="contents">
            <ModelOverrideFields
              value={review}
              onChange={setReview}
              parent={agentModel}
              credBaseUrl={reviewCredBaseUrl}
              credentialError={reviewCredentialError}
              sameAsLabel={sameAsAgent}
              credentialHint={t(
                "editor.reviewCredentialHint",
                "Required when the reviewer uses another provider; without its own key, suggestions reach the queue unreviewed.",
              )}
              baseURLHint={t(
                "editor.reviewBaseURLHint",
                "Required for OpenAI-compatible endpoints, unless the credential already carries one.",
              )}
            />
          </fieldset>
        </Section>
      )}
      <TabActionBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
        saveLabel={t("editor.saveKnowledge", "Save knowledge")}
        onOpenPlayground={onOpenPlayground}
        // The reviewer's fields are not drawn without suggestions, so they cannot hold the save.
        saveDisabled={suggestions && (baseUrlInvalid || baseUrlUnsupported)}
      />
    </div>
  );
}
