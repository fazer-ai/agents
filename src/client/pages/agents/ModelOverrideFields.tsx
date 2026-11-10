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
import {
  type AgentModelSource,
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
  overrideNeedsOwnCredential,
  overridePicked,
  overridePickerSource,
  overrideProviderChanged,
} from "./modelOverrideForm";

// The four fields of a model of its own (provider, API key, model, base URL), drawn the one way every
// such section draws them: each field always shown, inheriting field by field from a parent model
// through `resolveModelOverride`, the provider pinned by what is picked for it, and the endpoint
// checked before the save. A new section that lets the operator choose a model uses this, so the
// screens cannot drift apart (docs/ui.md, "A model of its own").

// The form's spelling of an override: blank strings, never null.
export interface ModelOverrideForm {
  provider: string;
  model: string;
  credentialRef: string;
  baseURL: string;
}

interface ModelOverrideFieldsProps {
  value: ModelOverrideForm;
  onChange: (update: (prev: ModelOverrideForm) => ModelOverrideForm) => void;
  // The model these fields inherit from, field by field, with its effective endpoint.
  parent: AgentModelSource;
  // The endpoint the section's own credential carries, which outranks the typed field.
  credBaseUrl: string | null;
  credentialError?: string;
  // What the first provider option and the inherited model read: "Same as the agent", or the
  // parent's equivalent.
  sameAsLabel: string;
  // What happens without a key of its own, in the section's words.
  credentialHint: string;
  baseURLHint: string;
}

export function ModelOverrideFields({
  value,
  onChange,
  parent,
  credBaseUrl,
  credentialError,
  sameAsLabel,
  credentialHint,
  baseURLHint,
}: ModelOverrideFieldsProps) {
  const { t } = useTranslation();
  const source = overridePickerSource(value, parent, credBaseUrl);
  const effectiveProvider = value.provider || parent.provider;
  const needsOwnCredential = overrideNeedsOwnCredential(
    value,
    parent,
    credBaseUrl,
  );
  const baseUrlInvalid = overrideBaseUrlInvalid(
    value,
    parent,
    credBaseUrl,
    true,
  );
  const baseUrlUnsupported = overrideBaseUrlUnsupported(
    value,
    parent,
    credBaseUrl,
    true,
  );
  return (
    <>
      <FormField label={t("editor.provider", "Provider")}>
        <Select
          value={value.provider}
          onChange={(e) =>
            onChange((prev) => overrideProviderChanged(prev, e.target.value))
          }
        >
          <option value="">{sameAsLabel}</option>
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
        description={credentialHint}
        group
      >
        <CredentialPicker
          value={value.credentialRef}
          onChange={(v) =>
            onChange((prev) =>
              overridePicked(prev, "credentialRef", v, parent.provider),
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
              overridePicked(prev, "model", v, parent.provider),
            )
          }
          provider={effectiveProvider}
          credentialRef={source.credentialRef || undefined}
          baseURL={source.baseURL || undefined}
          // Blank inherits the parent's model while the provider is unchanged, and only falls
          // back to the provider default once it differs. The placeholder says the same thing.
          placeholder={
            effectiveProvider === parent.provider ? sameAsLabel : undefined
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
              : baseURLHint
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
    </>
  );
}
