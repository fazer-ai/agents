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
import { useVaultBaseUrls } from "@/client/lib/vaultCache";
import {
  MODEL_PROVIDERS,
  PROVIDERS_HONORING_BASE_URL,
} from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import type { OccurrenceModel } from "@/modules/occurrences/settings";

// The monitor's model as the form edits it: blank strings for what the server stores as null.
export interface ModelDraft {
  provider: string;
  model: string;
  credentialRef: string;
  baseURL: string;
}

export const EMPTY_MODEL: ModelDraft = {
  provider: "openai",
  model: PROVIDER_DEFAULT_MODEL.openai ?? "",
  credentialRef: "",
  baseURL: "",
};

const takesBaseUrl = (provider: string) =>
  (PROVIDERS_HONORING_BASE_URL as readonly string[]).includes(provider);

export function toDraft(m: OccurrenceModel | null): ModelDraft | null {
  return m === null
    ? null
    : {
        provider: m.provider,
        model: m.model ?? "",
        credentialRef: m.credentialRef ?? "",
        baseURL: m.baseURL ?? "",
      };
}

export function fromDraft(d: ModelDraft | null): OccurrenceModel | null {
  return d === null
    ? null
    : {
        provider: d.provider as OccurrenceModel["provider"],
        model: d.model.trim() || null,
        credentialRef: d.credentialRef.trim() || null,
        // Only a provider that dials an endpoint keeps one: switching away from it drops it.
        baseURL: takesBaseUrl(d.provider) ? d.baseURL.trim() || null : null,
      };
}

// What keeps the model's draft from saving, said in words; null when it can save. The endpoint may
// come from the credential, as the round resolves it (model.ts, resolveMonitorModel).
export function modelProblem(
  s: ModelDraft,
  t: (k: string, d: string) => string,
  credentialBase?: string | null,
): string | null {
  if (s.provider !== "openai-compatible" && !s.credentialRef.trim())
    return t("occurrences.models.needsCredential", "Choose the API key.");
  if (s.provider === "openai-compatible" && !s.model.trim())
    return t("occurrences.models.needsModel", "Type the model id.");
  if (
    s.provider === "openai-compatible" &&
    !s.baseURL.trim() &&
    !credentialBase
  )
    return t("occurrences.models.needsEndpoint", "Type the base URL.");
  return null;
}

// The monitor's one model, laid out as the agent's Model card: provider and model on one row, the API
// key below, and the base URL when the provider dials one. No agent is borrowed.
export function OccurrenceModelSection({
  value,
  onChange,
}: {
  value: ModelDraft;
  onChange: (v: ModelDraft) => void;
}) {
  const { t } = useTranslation();
  const baseUrlOf = useVaultBaseUrls();
  const credBase = baseUrlOf(value.credentialRef) ?? undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t("editor.provider", "Provider")}>
          <Select
            value={value.provider}
            onChange={(e) => {
              const provider = e.target.value;
              // A model id and an endpoint belong to their provider: switching jumps to the new one's
              // default model and drops the endpoint, which would otherwise carry the new key there.
              onChange({
                ...value,
                provider,
                model: PROVIDER_DEFAULT_MODEL[provider] ?? "",
                baseURL: "",
              });
            }}
          >
            {MODEL_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p, t)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t("editor.model", "Model")} group>
          <ModelPicker
            value={value.model}
            onChange={(v) => onChange({ ...value, model: v })}
            provider={value.provider}
            credentialRef={value.credentialRef || undefined}
            // The model's own endpoint first, as the round calls it.
            baseURL={value.baseURL.trim() || credBase}
            aria-label={t("editor.model", "Model")}
          />
        </FormField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {/* The picker says a missing key itself, and offers to create one here: an account on its
            first run has none. */}
        <FormField label={t("editor.credential", "API key")} group>
          <CredentialPicker
            value={value.credentialRef}
            onChange={(v) => onChange({ ...value, credentialRef: v })}
            required={value.provider !== "openai-compatible"}
            createLabel={t("occurrences.models.createKey", "Create a key")}
            compatibleTypes={credentialCompat.model(value.provider)}
            defaultCreateType={credentialCompat.model(value.provider)[0]}
            ariaLabel={t("editor.credential", "API key")}
          />
        </FormField>
      </div>
      {takesBaseUrl(value.provider) && (
        <FormField
          label={t("editor.baseURL", "Base URL")}
          description={
            credBase && !value.baseURL.trim()
              ? t(
                  "editor.baseURLFromCredential",
                  "Defined by the selected credential.",
                )
              : value.provider === "openai-compatible"
                ? t(
                    "editor.baseURLHint",
                    "Required for OpenAI-compatible providers.",
                  )
                : undefined
          }
        >
          <Input
            value={value.baseURL}
            onChange={(e) => onChange({ ...value, baseURL: e.target.value })}
            placeholder={credBase ?? "https://api.provider.com/v1"}
          />
        </FormField>
      )}
    </div>
  );
}
