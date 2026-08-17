import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/client/lib/api";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import { ComboBox, type ComboItem } from "./ComboBox";

interface ProviderModel {
  id: string;
  label?: string;
}

// Mirrors ModelCapability in src/modules/models/service.ts (kept local so the client bundle never
// reaches into server code). Picks which models the listing endpoint returns.
type ModelCapability = "chat" | "transcription" | "vision";

// Module-scope cache so the list survives tab switches and editor remounts (a per-component ref would
// refetch on every mount). Keyed by provider+credentialRef+baseURL+capability — agent-independent, so
// agents sharing a credential also share the cache. TTL keeps newly released models reachable without a
// page reload; errors are never cached (next open retries).
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const modelsCache = new Map<string, { models: ProviderModel[]; at: number }>();

function cacheKey(
  provider: string,
  credentialRef: string | undefined,
  baseURL: string | undefined,
  capability: ModelCapability,
): string {
  return `${capability}||${provider}||${credentialRef ?? ""}||${baseURL ?? ""}`;
}

function readCache(key: string): ProviderModel[] | undefined {
  const entry = modelsCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > MODELS_CACHE_TTL_MS) {
    modelsCache.delete(key);
    return undefined;
  }
  return entry.models;
}

function toItems(models: ProviderModel[]): ComboItem[] {
  return models.map((m) => {
    // Path-like ids (llama.cpp exposes the model FILE PATH) get NO raw-id hint: the basename label
    // is the identity, and the full path only blows up the row/trigger. The explicit "" also
    // suppresses the ComboBox trigger's fallback-to-value parenthetical.
    const pathLike = /[\\/]/.test(m.id);
    return {
      id: m.id,
      label: m.label,
      hint: pathLike ? "" : m.label && m.label !== m.id ? m.id : undefined,
    };
  });
}

type Props = {
  value: string;
  onChange: (v: string) => void;
  provider: string;
  credentialRef?: string;
  baseURL?: string;
  capability?: ModelCapability;
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
};

// Thin wrapper over the generic ComboBox: feeds it the provider model list (cached) and the model
// labels. Eager-loads so the trigger shows the human label without opening the dropdown.
export function ModelPicker({
  value,
  onChange,
  provider,
  credentialRef,
  baseURL,
  capability = "chat",
  placeholder,
  disabled,
  "aria-label": ariaLabel,
}: Props) {
  const { t } = useTranslation();
  const key = cacheKey(provider, credentialRef, baseURL, capability);
  // An empty field still shows this text, so it has to be the model the runtime would actually use.
  // It used to be the literal "gpt-5.4-mini" for every provider, which read as "Anthropic will run
  // gpt-5.4-mini" under Anthropic. Only chat has a per-provider table here.
  //
  // NOTE: A caller's placeholder wins even when it is the empty string, which is a deliberate value
  // and not an omission: the vision and STT tabs pass `X_DEFAULT_MODEL[provider] ?? ""`, and for
  // openai-compatible those tables hold "" precisely because no default exists and the endpoint
  // needs a named model. Promising "provider default" there would invite an empty field the request
  // cannot satisfy. Hence `!== undefined` rather than a truthiness fallback.
  const providerDefault = t(
    "editor.modelPickerProviderDefault",
    "Provider default",
  );
  const shown =
    placeholder !== undefined
      ? placeholder
      : capability === "chat"
        ? PROVIDER_DEFAULT_MODEL[provider] || providerDefault
        : providerDefault;

  const loader = useCallback(async (): Promise<ComboItem[]> => {
    const cached = readCache(key);
    if (cached) return toItems(cached);
    if (!credentialRef) return [];
    const { data, error } = await api.api.v1.agents.models.list.post({
      provider,
      credentialRef,
      baseURL,
      capability,
    });
    if (error || !data) throw new Error("model list failed");
    const models = data.models as ProviderModel[];
    // Don't cache an empty list: an empty result means the credential isn't usable yet (pending),
    // so we must refetch once it's filled instead of serving a stale empty list for the whole TTL.
    if (models.length > 0) modelsCache.set(key, { models, at: Date.now() });
    return toItems(models);
  }, [key, provider, credentialRef, baseURL, capability]);

  return (
    <ComboBox
      value={value}
      onChange={onChange}
      loader={loader}
      loaderKey={key}
      eager
      needsCredential={!credentialRef}
      placeholder={shown}
      searchPlaceholder={t("editor.modelPickerSearch", "Search models…")}
      disabled={disabled}
      aria-label={ariaLabel ?? t("editor.model", "Model")}
    />
  );
}
