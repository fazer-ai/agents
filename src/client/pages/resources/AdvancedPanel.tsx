import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  CredentialPicker,
  DataBoundary,
  FormField,
  Switch,
  useToast,
} from "@/client/components";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

type Settings = NonNullable<
  Awaited<ReturnType<(typeof api.api.v1)["tenant-settings"]["get"]>>["data"]
>;

// Pinned server-side (see updateEmbeddingSettings); shown read-only until flexible embeddings ship.
const EMBEDDING_MODEL = "text-embedding-3-small";

// Tenant-level feature config (TENANT_ADMIN): the RAG embedding credential and the Langfuse tracing
// keys. The embedding provider/model are LOCKED to OpenAI + text-embedding-3-small for now (only the
// credential is editable); the flexible-embeddings feature (configurable dimension + provider
// registry, incl. Hugging Face) is deferred.
export function AdvancedPanel() {
  const { t } = useTranslation();
  const tracingId = useId();
  const sendContentId = useId();
  const debugId = useId();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Embedding (only the credential is configurable; provider/model are pinned server-side).
  const [embCredential, setEmbCredential] = useState("");
  const [embSaving, setEmbSaving] = useState(false);

  const [lfEnabled, setLfEnabled] = useState(false);
  const [lfCredentialRef, setLfCredentialRef] = useState<string | null>(null);
  const [lfSendContent, setLfSendContent] = useState(false);
  const [lfDebug, setLfDebug] = useState(false);
  const [lfSaving, setLfSaving] = useState(false);

  const apply = useCallback((s: Settings) => {
    setEmbCredential(s.embedding.credentialRef ?? "");
    setLfEnabled(s.langfuse.enabled);
    setLfCredentialRef(s.langfuse.credentialRef);
    setLfSendContent(s.langfuse.sendContent);
    setLfDebug(s.langfuse.debug);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1["tenant-settings"].get();
      if (err || !data) throw err ?? new Error("no data");
      apply(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveEmbedding() {
    setEmbSaving(true);
    try {
      const { error: err } = await api.api.v1["tenant-settings"].embedding.put({
        credentialRef: embCredential || null,
      });
      if (err) throw err;
      showToast(
        t("advanced.embedding.saved", "Embedding settings saved."),
        "success",
      );
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t(
            "advanced.embedding.saveError",
            "Could not save embedding settings.",
          ),
        "error",
      );
    } finally {
      setEmbSaving(false);
    }
  }

  async function saveLangfuse() {
    setLfSaving(true);
    try {
      const { data, error: err } = await api.api.v1[
        "tenant-settings"
      ].langfuse.put({
        enabled: lfEnabled,
        credentialRef: lfCredentialRef,
        sendContent: lfSendContent,
        debug: lfDebug,
      });
      if (err || !data) throw err ?? new Error("no data");
      setLfCredentialRef(data.langfuse.credentialRef);
      showToast(
        t("advanced.observability.saved", "Observability settings saved."),
        "success",
      );
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t(
            "advanced.observability.saveError",
            "Could not save observability settings.",
          ),
        "error",
      );
    } finally {
      setLfSaving(false);
    }
  }

  return (
    <DataBoundary loading={loading} error={error} onRetry={load}>
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="font-medium text-text-primary">
              {t("advanced.embedding.title", "Embedding")}
            </h2>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "advanced.embedding.desc",
                "Provider and credential used to vectorize and search your knowledge bases.",
              )}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <ServiceLogo
                service="openai"
                className="h-5 w-5 shrink-0 text-text-secondary"
              />
              <div className="min-w-0">
                <p className="font-medium text-sm text-text-primary">
                  {t("vault.secretType.openai", "OpenAI")}
                </p>
                <p className="truncate text-text-muted text-xs">
                  {EMBEDDING_MODEL}
                </p>
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-text-muted text-xs">
              {t(
                "advanced.embedding.comingSoon",
                "More embedding providers and models coming soon.",
              )}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-sm text-text-secondary">
              {t("advanced.embedding.credential", "Credential")}
            </span>
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <CredentialPicker
                  value={embCredential}
                  onChange={setEmbCredential}
                  compatibleTypes={["openai"]}
                  ariaLabel={t("advanced.embedding.credential", "Credential")}
                />
              </div>
              <Button size="sm" onClick={saveEmbedding} loading={embSaving}>
                {t("common.save", "Save")}
              </Button>
            </div>
          </div>
        </Card>

        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="font-medium text-text-primary">
              {t("advanced.observability.title", "Observability (Langfuse)")}
            </h2>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "advanced.observability.desc",
                "Send agent traces to Langfuse. Content is redacted unless you opt in.",
              )}
            </p>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <label
              htmlFor={tracingId}
              data-clickable="true"
              className="font-medium text-sm text-text-primary"
            >
              {t("advanced.observability.enabled", "Enable tracing")}
            </label>
            <Switch
              id={tracingId}
              checked={lfEnabled}
              onCheckedChange={setLfEnabled}
            />
          </div>
          <FormField
            label={t(
              "advanced.observability.credential",
              "Langfuse credential",
            )}
            group
            description={t(
              "advanced.observability.credentialHint",
              "Public key, secret key and host are stored in the credential. Use the Vault tab to create or update it.",
            )}
          >
            <CredentialPicker
              value={lfCredentialRef ?? ""}
              onChange={(v) => setLfCredentialRef(v || null)}
              compatibleTypes={["langfuse"]}
              allowNone
              ariaLabel={t(
                "advanced.observability.credential",
                "Langfuse credential",
              )}
            />
          </FormField>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div className="flex flex-col gap-0.5 pr-4">
              <label
                htmlFor={sendContentId}
                data-clickable="true"
                className="text-sm text-text-secondary"
              >
                {t(
                  "advanced.observability.sendContent",
                  "Send conversation content",
                )}
              </label>
              <span className="text-text-muted text-xs">
                {t(
                  "advanced.observability.sendContentHint",
                  "When off, conversation text is masked before sending; turn structure, tool calls, latencies, tokens and costs still appear in traces. Enable only if you accept sending conversation content to Langfuse.",
                )}
              </span>
            </div>
            <Switch
              id={sendContentId}
              checked={lfSendContent}
              onCheckedChange={setLfSendContent}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div className="flex flex-col gap-0.5 pr-4">
              <label
                htmlFor={debugId}
                data-clickable="true"
                className="text-sm text-text-secondary"
              >
                {t("advanced.observability.debug", "Debug mode (tool schemas)")}
              </label>
              <span className="text-text-muted text-xs">
                {t(
                  "advanced.observability.debugHint",
                  "Sends the full schema of every available tool with each trace. Tool names always appear; enable this only while debugging tool exposure. Recommended off, since the full schemas bloat Langfuse.",
                )}
              </span>
            </div>
            <Switch
              id={debugId}
              checked={lfDebug}
              onCheckedChange={setLfDebug}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={saveLangfuse} loading={lfSaving}>
              {t("common.save", "Save")}
            </Button>
          </div>
        </Card>
      </div>
    </DataBoundary>
  );
}
