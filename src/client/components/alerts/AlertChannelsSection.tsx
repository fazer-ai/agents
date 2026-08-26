import { BellRing, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  CredentialPicker,
  DataBoundary,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Switch,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { flowStageLabel } from "@/client/lib/flowLabels";
import type { ApiErrorPayload } from "@/client/lib/types";
import { cn, formatDate } from "@/client/lib/utils";
import { isValidHttpUrl } from "@/client/lib/validation";
import { FLOW_STAGES } from "@/modules/flowlog/stages";

// Alert channel manager (external sinks for execution-flow warnings/errors). Lives on the Webhooks
// page (operationally adjacent). The token-bearing URL never comes back from the API — when editing,
// the URL field starts empty (the masked preview is shown) and is only sent when re-entered.

type ChannelsResponse = Awaited<
  ReturnType<(typeof api.api.v1)["alert-channels"]["get"]>
>["data"];
type AlertChannel = NonNullable<ChannelsResponse>["channels"][number];

const labelCls = "mb-1 block font-medium text-sm text-text-primary";
const selectCls =
  "w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none";

interface ChannelModalPayload {
  channel?: AlertChannel;
}

function AlertChannelModal({
  modal,
  onSaved,
}: {
  modal: ModalController<ChannelModalPayload>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const enabledId = useId();
  const editing = modal.payload?.channel;
  const [name, setName] = useState("");
  const [type, setType] = useState<"discord" | "webhook">("discord");
  const [url, setUrl] = useState("");
  const [minLevel, setMinLevel] = useState<"warn" | "error">("error");
  const [stages, setStages] = useState<Set<string>>(new Set());
  const [secretRef, setSecretRef] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useOnModalOpen(modal, () => {
    const ch = modal.payload?.channel;
    setName(ch?.name ?? "");
    setType((ch?.type as "discord" | "webhook") ?? "discord");
    // URL is masked server-side: start blank when editing (re-enter to change).
    setUrl("");
    setMinLevel((ch?.minLevel as "warn" | "error") ?? "error");
    // Default to ALL stages (new channel, or an existing one stored as [] = all); an existing subset
    // pre-checks exactly that subset. The operator then narrows from "everything" instead of an empty
    // set that silently meant "all".
    setStages(
      new Set(ch?.stages && ch.stages.length > 0 ? ch.stages : FLOW_STAGES),
    );
    setSecretRef("");
    setEnabled(ch?.enabled ?? true);
    setError("");
  });

  const toggleStage = (s: string) =>
    setStages((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const allStagesChecked = stages.size === FLOW_STAGES.length;
  const toggleAllStages = () =>
    setStages(allStagesChecked ? new Set() : new Set(FLOW_STAGES));

  const urlInvalid = url.trim().length > 0 && !isValidHttpUrl(url);
  // Creating needs a URL; editing keeps the existing one when left blank. At least one stage must be
  // selected — a channel that alerts on nothing is useless (disable it instead).
  const canSubmit =
    name.trim().length > 0 &&
    !urlInvalid &&
    stages.size > 0 &&
    (editing ? true : url.trim().length > 0);

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    try {
      const ref = secretRef.trim() || null;
      // All stages selected → persist [] (canonical "all", future-proof so a newly added stage is
      // covered automatically); a subset persists exactly that subset.
      const stagesArr = allStagesChecked ? [] : [...stages];
      let apiError: unknown;
      if (editing) {
        const patch: Record<string, unknown> = {
          name,
          type,
          minLevel,
          stages: stagesArr,
          secretRef: ref,
          enabled,
        };
        if (url.trim()) patch.url = url.trim();
        apiError = (
          await api.api.v1["alert-channels"]({ id: editing.id }).patch(patch)
        ).error;
      } else {
        apiError = (
          await api.api.v1["alert-channels"].post({
            name,
            type,
            url: url.trim(),
            minLevel,
            stages: stagesArr,
            secretRef: ref,
            enabled,
          })
        ).error;
      }
      if (apiError) {
        setError(
          (apiError as { value?: ApiErrorPayload }).value?.error ||
            t("alerts.saveFailed", "Could not save the channel"),
        );
        return;
      }
      onSaved();
      modal.close();
    } catch {
      setError(t("alerts.saveFailed", "Could not save the channel"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      modal={modal}
      size="md"
      title={
        editing
          ? t("alerts.editTitle", "Edit alert channel")
          : t("alerts.createTitle", "New alert channel")
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading && canSubmit) void handleSubmit();
        }}
      >
        {error && (
          <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="ac-name" className={labelCls}>
            {t("alerts.name", "Name")}
          </label>
          <Input
            id="ac-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={loading}
            placeholder={t("alerts.namePlaceholder", "e.g. Ops Discord")}
          />
        </div>

        <div>
          <label htmlFor="ac-type" className={labelCls}>
            {t("alerts.typeLabel", "Type")}
          </label>
          <select
            id="ac-type"
            className={selectCls}
            value={type}
            disabled={loading}
            onChange={(e) => setType(e.target.value as "discord" | "webhook")}
          >
            <option value="discord">
              {t("alerts.type.discord", "Discord")}
            </option>
            <option value="webhook">
              {t("alerts.type.webhook", "Generic webhook")}
            </option>
          </select>
        </div>

        <div>
          <label htmlFor="ac-url" className={labelCls}>
            {t("alerts.url", "Webhook URL")}
          </label>
          <Input
            id="ac-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
            placeholder={
              editing?.urlMasked
                ? editing.urlMasked
                : "https://discord.com/api/webhooks/…"
            }
            helperText={
              editing
                ? t(
                    "alerts.urlEditHint",
                    "Leave blank to keep the current URL. The stored URL is never shown.",
                  )
                : t(
                    "alerts.urlHint",
                    "Must be a public HTTPS URL. Private and metadata addresses are blocked.",
                  )
            }
          />
          {urlInvalid && (
            <p className="mt-1 text-error text-xs">
              {t("common.invalidUrl", "Must be a valid http(s) URL.")}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="ac-minlevel" className={labelCls}>
            {t("alerts.minLevelField", "Minimum level")}
          </label>
          <select
            id="ac-minlevel"
            className={selectCls}
            value={minLevel}
            disabled={loading}
            onChange={(e) => setMinLevel(e.target.value as "warn" | "error")}
          >
            <option value="error">
              {t("alerts.minLevel.error", "Errors only")}
            </option>
            <option value="warn">
              {t("alerts.minLevel.warn", "Warnings and errors")}
            </option>
          </select>
        </div>

        <fieldset>
          <legend
            className={cn(labelCls, "flex w-full items-center justify-between")}
          >
            <span>{t("alerts.stages", "Stages")}</span>
            <button
              type="button"
              disabled={loading}
              onClick={toggleAllStages}
              className="font-normal text-accent text-xs hover:underline"
            >
              {allStagesChecked
                ? t("alerts.clearAll", "Clear")
                : t("alerts.selectAll", "Select all")}
            </button>
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {FLOW_STAGES.map((s) => {
              const checked = stages.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  disabled={loading}
                  onClick={() => toggleStage(s)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    {
                      "border-accent bg-accent-soft text-text-primary": checked,
                      "border-border text-text-secondary hover:bg-bg-hover":
                        !checked,
                    },
                  )}
                >
                  {flowStageLabel(s, t)}
                </button>
              );
            })}
          </div>
        </fieldset>

        {type === "webhook" && (
          <FormField
            label={t("alerts.secretRef", "Signing secret (optional)")}
            group
            description={t(
              "alerts.secretRefHint",
              "Signs each delivery (HMAC) so your endpoint can verify it. Discord ignores this.",
            )}
          >
            <CredentialPicker
              value={secretRef}
              onChange={setSecretRef}
              disabled={loading}
              ariaLabel={t("alerts.secretRef", "Signing secret (optional)")}
            />
          </FormField>
        )}

        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
          <label
            htmlFor={enabledId}
            className="font-medium text-sm text-text-primary"
          >
            {t("common.enabled", "Enabled")}
          </label>
          <Switch
            id={enabledId}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={loading}
          />
        </div>

        <div className="flex justify-end gap-2">
          <ModalCancelButton disabled={loading} />
          <Button
            type="submit"
            loading={loading}
            disabled={loading || !canSubmit}
          >
            {t("common.save", "Save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AlertChannelsSection() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const modal = useModalController<ChannelModalPayload>();
  const confirm = useModalController<ConfirmPayload>();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1["alert-channels"].get();
      if (err) {
        setError(true);
        return;
      }
      setChannels(data?.channels ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const toggleEnabled = async (ch: AlertChannel) => {
    const next = !ch.enabled;
    setChannels((prev) =>
      prev.map((c) => (c.id === ch.id ? { ...c, enabled: next } : c)),
    );
    const { error: err } = await api.api.v1["alert-channels"]({
      id: ch.id,
    }).patch({ enabled: next });
    if (err) {
      setChannels((prev) =>
        prev.map((c) => (c.id === ch.id ? { ...c, enabled: ch.enabled } : c)),
      );
      showToast(
        apiErrorMessage(err) ||
          t("alerts.saveFailed", "Could not save the channel"),
        "error",
      );
    }
  };

  const requestDelete = (ch: AlertChannel) => {
    confirm.open({
      title: t("alerts.deleteTitle", "Delete alert channel"),
      message: t(
        "alerts.deleteMessage",
        "This channel will stop receiving alerts. This cannot be undone.",
      ),
      confirmLabel: t("common.delete", "Delete"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1["alert-channels"]({
          id: ch.id,
        }).delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("alerts.deleteFailed", "Could not delete the channel"),
            "error",
          );
          throw new Error("delete failed");
        }
        showToast(t("alerts.deleted", "Channel deleted"), "success");
        void fetchAll();
      },
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-text-primary text-xl">
            {t("alerts.title", "Alert channels")}
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            {t(
              "alerts.subtitle",
              "Get notified on Discord or your own endpoint when an agent step warns or fails.",
            )}
          </p>
        </div>
        <Button onClick={() => modal.open({})}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("alerts.create", "New channel")}
        </Button>
      </div>

      <AlertChannelModal
        modal={modal}
        onSaved={() => {
          showToast(t("alerts.saved", "Channel saved"), "success");
          void fetchAll();
        }}
      />
      <ConfirmDialog modal={confirm} />

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={channels.length === 0}
        onRetry={() => void fetchAll()}
        empty={
          <EmptyState
            icon={BellRing}
            title={t("alerts.emptyTitle", "No alert channels")}
            description={t(
              "alerts.emptyDescription",
              "Add a Discord or webhook channel to be paged when a step fails.",
            )}
          />
        }
      >
        <div className="flex flex-col gap-3">
          {channels.map((ch) => (
            <Card
              key={ch.id}
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm text-text-primary">
                    {ch.name}
                  </span>
                  <Badge variant="secondary">{ch.type}</Badge>
                  {!ch.enabled && (
                    <Badge variant="secondary">
                      {t("alerts.disabled", "Disabled")}
                    </Badge>
                  )}
                </div>
                <span className="truncate font-mono text-text-muted text-xs">
                  {ch.urlMasked}
                </span>
                <span className="text-text-muted text-xs">
                  {t("alerts.minLevelLabel", "Min level: {{level}}", {
                    level: ch.minLevel,
                  })}
                  {" · "}
                  {ch.stages.length > 0
                    ? ch.stages.map((s) => flowStageLabel(s, t)).join(", ")
                    : t("alerts.allStages", "All stages")}
                  {ch.hasSecret ? ` · ${t("alerts.signed", "Signed")}` : ""}
                  {" · "}
                  {t("alerts.createdAt", "Created {{date}}", {
                    date: formatDate(ch.createdAt),
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={ch.enabled}
                  onCheckedChange={() => void toggleEnabled(ch)}
                  aria-label={t("common.enabled", "Enabled")}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => modal.open({ channel: ch })}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  {t("common.edit", "Edit")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => requestDelete(ch)}
                  aria-label={t("alerts.deleteAria", "Delete channel")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </DataBoundary>
    </section>
  );
}
