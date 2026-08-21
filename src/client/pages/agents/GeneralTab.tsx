import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  CredentialPicker,
  FormField,
  Input,
  Modal,
  ModelPicker,
  Select,
  SwitchField,
  useModalController,
} from "@/client/components";
import { useActiveTenantName } from "@/client/hooks/useActiveTenantName";
import { credentialCompat } from "@/client/lib/credentialCompat";
import { providerLabel } from "@/client/lib/providerLabels";
import { cn } from "@/client/lib/utils";
import { isValidHttpUrl } from "@/client/lib/validation";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import { REASONING_EFFORTS } from "@/graph/openai-reasoning";
import type { Schedule } from "@/modules/business-hours/hours";
import { CapabilityMap } from "./CapabilityMap";
import { PromptPanel } from "./PromptPanel";
import { TabActionBar } from "./TabActionBar";
import type { GrantState, ToolCatalog } from "./types";

interface ModelState {
  provider: string;
  model: string;
  credentialRef: string;
  baseURL: string;
  temperature: string;
  // Empty = never chosen, which is not the same as "none": the provider's own default stays.
  reasoningEffort: string;
}

interface GeneralTabProps {
  name: string;
  setName: (v: string) => void;
  systemPrompt: string;
  setSystemPrompt: (v: string) => void;
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  mode: "test" | "production";
  setMode: (v: "test" | "production") => void;
  model: ModelState;
  setModel: React.Dispatch<React.SetStateAction<ModelState>>;
  modelCredBaseUrl: string | null;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onOpenPlayground: () => void;
  // Opens the strong-confirm delete flow (owned by the editor page). Rendered as a danger zone at
  // the end of this tab instead of a header button.
  onDelete: () => void;
  // Simulated context-var values shared with the playground (its "Prompt variables" panel), so the
  // preview and a playground turn resolve {{nome_contato}} etc. to the SAME values. Blank entries
  // fall back to the built-in examples / real company+agent.
  previewVars?: Record<string, string>;
  // The agent's Availability (from the Behavior tab's schedule picker), so the prompt preview resolves
  // {{esta_aberto}} & co. to what the runtime would say. null = no Availability configured.
  availability?: { schedule: Schedule | null };
  // Resolved tool set, for the read-only capability map / agent graph shown at the bottom of this tab.
  catalog?: ToolCatalog;
  grants?: GrantState[];
}

export function GeneralTab({
  name,
  setName,
  systemPrompt,
  setSystemPrompt,
  enabled,
  setEnabled,
  mode,
  setMode,
  model,
  setModel,
  modelCredBaseUrl,
  dirty,
  saving,
  onSave,
  onDiscard,
  onOpenPlayground,
  onDelete,
  previewVars,
  availability,
  catalog,
  grants,
}: GeneralTabProps) {
  const { t } = useTranslation();
  const tenantName = useActiveTenantName();
  const promptModal = useModalController();

  const modelBaseUrlInvalid =
    model.provider === "openai-compatible" &&
    !modelCredBaseUrl &&
    !isValidHttpUrl(model.baseURL);

  return (
    <div className="flex grow flex-col gap-4">
      <Card className="flex flex-col gap-4">
        <div>
          <h3 className="font-medium text-sm text-text-primary">
            {t("editor.identitySection", "Identity")}
          </h3>
          <p className="text-text-muted text-xs">
            {t(
              "editor.identitySectionHint",
              "Name, system prompt and whether the agent is active.",
            )}
          </p>
        </div>
        <div className="flex items-end gap-4">
          <FormField
            label={t("editor.name", "Name")}
            required
            className="min-w-0 flex-1"
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <SwitchField
            checked={enabled}
            onCheckedChange={setEnabled}
            label={t("common.enabled", "Enabled")}
            className="h-10 shrink-0"
          />
        </div>
        <FormField
          label={t("editor.mode", "Mode")}
          description={t(
            "editor.modeHint",
            "A test agent stays silent in a conversation until the customer sends /teste; production answers normally.",
          )}
          group
        >
          <div className="inline-flex self-start rounded-lg border border-border bg-bg-tertiary p-0.5">
            {(["test", "production"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={cn(
                  "rounded-md px-4 py-1.5 font-medium text-sm transition-colors",
                  mode === m
                    ? "bg-accent text-accent-foreground"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                {m === "test"
                  ? t("editor.modeTest", "Test")
                  : t("editor.modeProduction", "Production")}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label={t("editor.systemPrompt", "Agent instructions")} group>
          <PromptPanel
            value={systemPrompt}
            onChange={setSystemPrompt}
            previewVars={previewVars}
            availability={availability}
            companyFallback={tenantName}
            agentFallback={name}
            onExpand={() => promptModal.open()}
          />
        </FormField>
      </Card>

      <Card id="general-model" className="flex scroll-mt-4 flex-col gap-4">
        <div>
          <h3 className="font-medium text-sm text-text-primary">
            {t("editor.modelSection", "Model")}
          </h3>
          <p className="text-text-muted text-xs">
            {t("editor.modelSectionHint", "Which LLM powers this agent.")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t("editor.provider", "Provider")}>
            <Select
              value={model.provider}
              onChange={(e) => {
                const provider = e.target.value;
                // Switching provider invalidates the previous model id, so jump to the new
                // provider's default instead of carrying a foreign id (or clearing the form).
                setModel({
                  ...model,
                  provider,
                  model: PROVIDER_DEFAULT_MODEL[provider] ?? "",
                });
              }}
            >
              <option value="">{t("editor.selectProvider", "Select…")}</option>
              {MODEL_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p, t)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t("editor.model", "Model")} group>
            <ModelPicker
              value={model.model}
              onChange={(v) => setModel({ ...model, model: v })}
              provider={model.provider}
              credentialRef={model.credentialRef || undefined}
              baseURL={modelCredBaseUrl ?? (model.baseURL || undefined)}
              aria-label={t("editor.model", "Model")}
            />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t("editor.credential", "API key")} group>
            <CredentialPicker
              value={model.credentialRef}
              onChange={(v) => setModel({ ...model, credentialRef: v })}
              required={model.provider !== "openai-compatible"}
              compatibleTypes={credentialCompat.model(model.provider)}
              defaultCreateType={credentialCompat.model(model.provider)[0]}
              testBaseUrl={modelCredBaseUrl ? undefined : model.baseURL}
              ariaLabel={t("editor.credential", "API key")}
            />
          </FormField>
          <FormField
            label={t("editor.temperature", "Temperature")}
            description={t("editor.temperatureHint", "0-2 (optional)")}
          >
            <Input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={model.temperature}
              onChange={(e) =>
                setModel({ ...model, temperature: e.target.value })
              }
            />
          </FormField>
        </div>
        {model.provider === "openai" && (
          <FormField
            label={t("editor.reasoningEffort", "Reasoning effort")}
            description={t(
              "editor.reasoningEffortHint",
              "How much the model thinks before answering. Reasoning models only (o-series, gpt-5); more effort means slower, costlier answers.",
            )}
          >
            <Select
              value={model.reasoningEffort}
              onChange={(e) =>
                setModel({ ...model, reasoningEffort: e.target.value })
              }
            >
              <option value="">
                {t("editor.reasoningEffortDefault", "Provider default")}
              </option>
              {REASONING_EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        {model.provider === "openai-compatible" && (
          <FormField
            label={t("editor.baseURL", "Base URL")}
            description={
              modelCredBaseUrl
                ? t(
                    "editor.baseURLFromCredential",
                    "Defined by the selected credential.",
                  )
                : t(
                    "editor.baseURLHint",
                    "Required for OpenAI-compatible providers.",
                  )
            }
            error={
              modelBaseUrlInvalid && model.baseURL.trim()
                ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                : null
            }
          >
            <Input
              value={modelCredBaseUrl ?? model.baseURL}
              onChange={(e) => setModel({ ...model, baseURL: e.target.value })}
              disabled={!!modelCredBaseUrl}
              placeholder="https://api.provider.com/v1"
            />
          </FormField>
        )}
      </Card>

      {catalog && grants && (
        <CapabilityMap catalog={catalog} grants={grants} agentName={name} />
      )}

      <TabActionBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
        saveDisabled={!name.trim() || modelBaseUrlInvalid}
        onOpenPlayground={onOpenPlayground}
      />

      <Card className="flex flex-col gap-3 border-error/40">
        <div>
          <h3 className="font-medium text-error text-sm">
            {t("editor.dangerZone", "Danger zone")}
          </h3>
          <p className="text-text-muted text-xs">
            {t(
              "editor.dangerZoneHint",
              "Permanently delete this agent. This cannot be undone.",
            )}
          </p>
        </div>
        <Button
          variant="danger"
          size="sm"
          onClick={onDelete}
          className="self-start"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {t("editor.deleteAgent", "Delete agent")}
        </Button>
      </Card>

      {/* NOTE: Expand-to-modal view: the SAME editor/preview toggle, taller, sharing the lifted
          prompt state so edits here and inline stay in sync. */}
      <Modal
        modal={promptModal}
        title={t("editor.promptModalTitle", "Edit agent instructions")}
        size="xl"
      >
        <div className="h-[72vh]">
          <PromptPanel
            variant="fill"
            value={systemPrompt}
            onChange={setSystemPrompt}
            previewVars={previewVars}
            availability={availability}
            companyFallback={tenantName}
            agentFallback={name}
          />
        </div>
      </Modal>
    </div>
  );
}
