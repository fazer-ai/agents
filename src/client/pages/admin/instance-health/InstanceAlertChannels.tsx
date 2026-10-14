import { BellRing, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
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
import { toastAlertTestResult } from "@/client/components/alerts/AlertChannelsSection";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDate } from "@/client/lib/utils";
import { isValidHttpUrl } from "@/client/lib/validation";
import { FILL_CHANNEL_PARAM } from "@/lib/console-params";
import { SIGNALS } from "@/modules/instance-health/signals";
import { signalLabel } from "./signals";

// The instance's alert channels: the same Discord or webhook destinations a tenant configures, for
// signals that belong to no tenant. The URL and the signing secret are write-only: editing starts
// both blank and sends each only when re-entered.

type ChannelsResponse = Awaited<
  ReturnType<(typeof api.api.v1)["instance-health"]["channels"]["get"]>
>["data"];
type Channel = NonNullable<ChannelsResponse>["channels"][number];

const SIGNAL_KEYS = SIGNALS.map((s) => s.name);
const labelCls = "mb-1 block font-medium text-sm text-text-primary";
const selectCls =
  "w-full rounded-md border border-border-hover bg-bg-tertiary h-8 px-2.5 text-sm text-text-primary transition-colors focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-accent-soft";

interface ChannelPayload {
  channel?: Channel;
}

function ChannelModal({
  modal,
  onSaved,
}: {
  modal: ModalController<ChannelPayload>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const typeId = useId();
  const urlId = useId();
  const secretId = useId();
  const enabledId = useId();
  const editing = modal.payload?.channel;
  const [name, setName] = useState("");
  const [type, setType] = useState<"discord" | "webhook">("discord");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [signals, setSignals] = useState<Set<string>>(new Set(SIGNAL_KEYS));
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useOnModalOpen(modal, () => {
    const ch = modal.payload?.channel;
    setName(ch?.name ?? "");
    setType((ch?.type as "discord" | "webhook") ?? "discord");
    setUrl("");
    setSecret("");
    setClearSecret(false);
    setSignals(
      new Set(ch?.signals && ch.signals.length > 0 ? ch.signals : SIGNAL_KEYS),
    );
    // A channel still waiting for its URL is disabled; filling it in is the moment to turn it on.
    setEnabled(ch?.urlMasked ? ch.enabled : true);
    setError("");
  });

  const allSignals = signals.size === SIGNAL_KEYS.length;
  const urlInvalid = url.trim().length > 0 && !isValidHttpUrl(url);
  const canSubmit =
    name.trim().length > 0 &&
    !urlInvalid &&
    signals.size > 0 &&
    (editing?.urlMasked ? true : url.trim().length > 0);

  const toggleSignal = (key: string) =>
    setSignals((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const submit = async () => {
    setError("");
    setLoading(true);
    const signalList = allSignals ? [] : [...signals];
    try {
      let apiError: unknown;
      if (editing) {
        const patch: Record<string, unknown> = {
          name,
          type,
          signals: signalList,
          enabled,
        };
        if (url.trim()) patch.url = url.trim();
        if (secret.trim()) patch.secret = secret.trim();
        else if (clearSecret) patch.secret = null;
        apiError = (
          await api.api.v1["instance-health"]
            .channels({ id: editing.id })
            .patch(patch)
        ).error;
      } else {
        apiError = (
          await api.api.v1["instance-health"].channels.post({
            name,
            type,
            url: url.trim(),
            signals: signalList,
            secret: type === "webhook" && secret.trim() ? secret.trim() : null,
            enabled,
          })
        ).error;
      }
      if (apiError) {
        setError(
          apiErrorMessage(apiError) ||
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
      // A save in flight finishes into this dialog: closing now would let it close the next one.
      busy={loading}
      title={
        editing
          ? t("instanceHealth.editChannelTitle", "Edit instance alert channel")
          : t("instanceHealth.createChannelTitle", "New instance alert channel")
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading && canSubmit) void submit();
        }}
      >
        {error && (
          <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
            {error}
          </div>
        )}
        <div>
          <label htmlFor={nameId} className={labelCls}>
            {t("alerts.name", "Name")}
          </label>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={loading}
            placeholder={t("alerts.namePlaceholder", "e.g. Ops Discord")}
          />
        </div>
        <div>
          <label htmlFor={typeId} className={labelCls}>
            {t("alerts.typeLabel", "Type")}
          </label>
          <select
            id={typeId}
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
          <label htmlFor={urlId} className={labelCls}>
            {t("alerts.url", "Webhook URL")}
          </label>
          <Input
            id={urlId}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading}
            placeholder={editing?.urlMasked ?? "https://"}
            error={urlInvalid}
          />
          {editing?.urlMasked && (
            <p className="mt-1 text-text-muted text-xs">
              {t(
                "instanceHealth.urlKeep",
                "Leave blank to keep the current URL.",
              )}
            </p>
          )}
        </div>
        {type === "webhook" && (
          <div>
            <label htmlFor={secretId} className={labelCls}>
              {t("instanceHealth.secret", "Signing secret (optional)")}
            </label>
            <Input
              id={secretId}
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={loading}
            />
            <p className="mt-1 text-text-muted text-xs">
              {editing?.hasSecret
                ? t(
                    "instanceHealth.secretKeep",
                    "A secret is set. Leave blank to keep it, or type a new one to replace it.",
                  )
                : t(
                    "instanceHealth.secretHint",
                    "Signs each delivery (HMAC) so your endpoint can verify it.",
                  )}
            </p>
            {editing?.hasSecret && (
              <label className="mt-2 flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked={clearSecret}
                  disabled={loading || secret.trim().length > 0}
                  onChange={(e) => setClearSecret(e.target.checked)}
                />
                {t("instanceHealth.secretClear", "Remove the signing secret")}
              </label>
            )}
          </div>
        )}
        <FormField
          group
          label={t("instanceHealth.signalsLabel", "Signals")}
          description={t(
            "instanceHealth.signalsHint",
            "All signals when every box is checked, including signals added later.",
          )}
        >
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {SIGNAL_KEYS.map((key) => (
              <label
                key={key}
                className="flex items-center gap-2 text-sm text-text-secondary"
              >
                <input
                  type="checkbox"
                  checked={signals.has(key)}
                  disabled={loading}
                  onChange={() => toggleSignal(key)}
                />
                {signalLabel(key, t)}
              </label>
            ))}
          </div>
        </FormField>
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

// Polled at the screen's cadence, so a delivery that fails or recovers shows without a reload.
export function InstanceAlertChannels({ pollMs }: { pollMs: number }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The list has been read at least once: until then an empty list is not an answer.
  const [loaded, setLoaded] = useState(false);
  // A background refresh that failed after a good load: the delivery status shown is from before.
  const [staleSince, setStaleSince] = useState<Date | null>(null);
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const modal = useModalController<ChannelPayload>();
  const confirm = useModalController<ConfirmPayload>();

  // Every read is numbered, the full load after a save and the background poll alike: a slow one
  // answering after a newer one was applied is dropped, so pre-save data never overwrites the list.
  const sent = useRef(0);
  const applied = useRef(0);
  const current = useCallback((id: number) => {
    if (id < applied.current) return false;
    applied.current = id;
    return true;
  }, []);

  const fetchAll = useCallback(async () => {
    const id = ++sent.current;
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } =
        await api.api.v1["instance-health"].channels.get();
      if (!current(id)) return;
      if (err) {
        setError(true);
        return;
      }
      setChannels(data?.channels ?? []);
      setLoaded(true);
      setStaleSince(null);
    } catch {
      if (current(id)) setError(true);
    } finally {
      setLoading(false);
    }
  }, [current]);

  useEffect(() => {
    void fetchAll();
    const timer = setInterval(async () => {
      const id = ++sent.current;
      try {
        const { data, error: err } =
          await api.api.v1["instance-health"].channels.get();
        if (!current(id)) return;
        if (!err && data) {
          setChannels(data.channels);
          setLoaded(true);
          setError(false);
          setStaleSince(null);
        } else {
          setStaleSince((prev) => prev ?? new Date());
        }
      } catch {
        if (current(id)) setStaleSince((prev) => prev ?? new Date());
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [current, fetchAll, pollMs]);

  // A tool that created a channel without its URL links here with `?fill=<id>`: open that channel's
  // dialog once the list has been read (a failed first read keeps the link for the next poll), and
  // drop the parameter so a reload does not open it again. Each link
  // is handled once: the parameter's removal is a navigation that commits later, and until then a
  // re-run would reopen the dialog over what the operator is typing.
  const [params, setParams] = useSearchParams();
  const fillId = params.get(FILL_CHANNEL_PARAM);
  const handledFill = useRef<string | null>(null);
  useEffect(() => {
    if (!fillId || !loaded || handledFill.current === fillId) return;
    handledFill.current = fillId;
    const ch = channels.find((c) => c.id === fillId);
    if (ch) modal.open({ channel: ch });
    else {
      showToast(
        t("instanceHealth.fillNotFound", "That alert channel no longer exists"),
        "error",
      );
    }
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(FILL_CHANNEL_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [fillId, loaded, channels, modal, setParams, showToast, t]);

  const toggleEnabled = async (ch: Channel) => {
    const next = !ch.enabled;
    setChannels((prev) =>
      prev.map((c) => (c.id === ch.id ? { ...c, enabled: next } : c)),
    );
    const { error: err } = await api.api.v1["instance-health"]
      .channels({ id: ch.id })
      .patch({ enabled: next });
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

  const runTest = async (ch: Channel) => {
    setTesting((prev) => new Set(prev).add(ch.id));
    try {
      const { data, error: err } = await api.api.v1["instance-health"]
        .channels({ id: ch.id })
        .test.post();
      const result = data?.result;
      if (err || !result) {
        showToast(
          apiErrorMessage(err) || t("alerts.testFailed", "Test alert failed"),
          "error",
        );
        return;
      }
      toastAlertTestResult(result, showToast, t);
    } catch {
      showToast(t("alerts.testFailed", "Test alert failed"), "error");
    } finally {
      setTesting((prev) => {
        const next = new Set(prev);
        next.delete(ch.id);
        return next;
      });
    }
  };

  const requestDelete = (ch: Channel) => {
    confirm.open({
      title: t("alerts.deleteTitle", "Delete alert channel"),
      message: t(
        "alerts.deleteMessage",
        "This channel will stop receiving alerts. This cannot be undone.",
      ),
      confirmLabel: t("common.delete", "Delete"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1["instance-health"]
          .channels({ id: ch.id })
          .delete();
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
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold text-base text-text-primary">
            {t("instanceHealth.channelsTitle", "Instance alerts")}
          </h2>
          <p className="text-sm text-text-secondary">
            {t(
              "instanceHealth.channelsSubtitle",
              "Where an alert goes when a signal stays above its threshold, and again when it recovers. These channels belong to the instance, not to a tenant.",
            )}
          </p>
        </div>
        <Button onClick={() => modal.open({})}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("alerts.create", "New channel")}
        </Button>
      </div>

      <ChannelModal
        modal={modal}
        onSaved={() => {
          showToast(t("alerts.saved", "Channel saved"), "success");
          void fetchAll();
        }}
      />
      <ConfirmDialog modal={confirm} />

      {staleSince && !error && (
        <div
          role="status"
          className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm"
        >
          {t(
            "instanceHealth.channelsStale",
            "Could not refresh the channels since {{time}}: their delivery status is from before then.",
            { time: staleSince.toLocaleTimeString() },
          )}
        </div>
      )}

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
              "instanceHealth.channelsEmpty",
              "Add a Discord or webhook channel to be told when the instance is saturated.",
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
                  {ch.urlMasked === null ? (
                    <Badge variant="warning">
                      {t("instanceHealth.awaitingUrl", "Waiting for its URL")}
                    </Badge>
                  ) : (
                    !ch.enabled && (
                      <Badge variant="secondary">
                        {t("alerts.disabled", "Disabled")}
                      </Badge>
                    )
                  )}
                </div>
                <span className="truncate font-mono text-text-muted text-xs">
                  {ch.urlMasked ??
                    t(
                      "instanceHealth.awaitingUrlHint",
                      "Created without a URL: edit it to set the URL and turn it on.",
                    )}
                </span>
                <span className="text-text-muted text-xs">
                  {ch.signals.length > 0
                    ? ch.signals.map((s) => signalLabel(s, t)).join(", ")
                    : t("instanceHealth.allSignals", "All signals")}
                  {ch.type === "webhook" &&
                    ch.hasSecret &&
                    !ch.unsignedReason &&
                    ` · ${t("alerts.signed", "Signed")}`}
                  {" · "}
                  {t("alerts.createdAt", "Created {{date}}", {
                    date: formatDate(ch.createdAt),
                  })}
                </span>
                {ch.unsignedReason && (
                  <span className="text-warning text-xs">
                    {t(
                      "instanceHealth.channelUnsigned",
                      "Deliveries go out unsigned: {{reason}}",
                      { reason: ch.unsignedReason },
                    )}
                  </span>
                )}
                {ch.failing && (
                  <span className="text-error text-xs">
                    {t(
                      "instanceHealth.channelFailing",
                      "The last alert ({{signal}}) was not delivered: {{error}}",
                      {
                        signal: signalLabel(ch.failing.signal, t),
                        error: ch.failing.error ?? "?",
                      },
                    )}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={ch.enabled}
                  disabled={ch.urlMasked === null}
                  onCheckedChange={() => void toggleEnabled(ch)}
                  aria-label={t("common.enabled", "Enabled")}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={testing.has(ch.id)}
                  disabled={testing.has(ch.id) || ch.urlMasked === null}
                  onClick={() => void runTest(ch)}
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                  {t("alerts.test", "Test")}
                </Button>
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
