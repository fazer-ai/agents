import { BellRing, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { flowStageLabel } from "@/client/lib/flowLabels";
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

type AgentOption = { id: string; name: string };

// The whole roster, for the exclusion chips. Paged by creation so a rename elsewhere cannot move a
// row between pages mid-walk; null when a page fails, because a partial roster would render an
// excluded agent as a bare id and invite the operator to drop it.
async function loadAgentOptions(): Promise<AgentOption[] | null> {
  const out: AgentOption[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const res = await api.api.v1.agents.get({
      query: { orderBy: "createdAt", order: "asc", page, pageSize: 100 },
    });
    if (res.error || !res.data) return null;
    for (const a of res.data.agents) out.push({ id: a.id, name: a.name });
    if (res.data.agents.length === 0 || out.length >= res.data.total) break;
  }
  return out;
}

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
  // Agents whose lines never alert here (issue #843). Sent whole on every save: the server accepts
  // an id the channel already held even when its agent is gone, so an untouched list always saves.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [agentOptions, setAgentOptions] = useState<AgentOption[] | null>(null);
  const [agentsFailed, setAgentsFailed] = useState(false);
  const [secretRef, setSecretRef] = useState("");
  // Whether the operator touched the picker at all. The wire needs to tell "left this alone" apart
  // from "chose this", because an untouched field is OMITTED and a sent one is obeyed — and the
  // difference cannot be read off the VALUE. A channel whose stored ref names no vault entry arrives
  // as `hasSecret` with no ref to show (`readableVaultRef` hides it rather than publish whatever text
  // the column held before #126), so its picker opens empty and choosing "None" moves nothing.
  // Comparing values would call that unchanged and leave the operator unable to clear a secret the
  // list is calling Signed.
  const [secretTouched, setSecretTouched] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const refusal = useFieldRefusal(
    modal.isOpen
      ? type === "webhook"
        ? ALERT_WEBHOOK_FIELDS
        : ALERT_FIELDS
      : [],
  );
  const [loading, setLoading] = useState(false);

  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
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
    // Loaded, not blanked: the save below sends `secretRef` unconditionally and the service reads a
    // null there as "clear it", so a blank field here unsigns the channel on a save that meant to
    // change the name. The URL above CAN start blank because the PATCH omits it when it is.
    setExcluded(new Set(ch?.excludeAgentIds ?? []));
    setAgentOptions(null);
    setAgentsFailed(false);
    void loadAgentOptions().then((opts) => {
      if (opts) setAgentOptions(opts);
      else setAgentsFailed(true);
    });
    setSecretRef(ch?.secretRef ?? "");
    setSecretTouched(false);
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

  const toggleExcluded = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Excluded ids with no agent behind them: shown, so the operator can see and drop them.
  const staleExcluded = agentOptions
    ? [...excluded].filter((id) => !agentOptions.some((a) => a.id === id))
    : [];

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

  // `secretRef` is three-valued on the way in — absent leaves it, null clears it, a value sets it —
  // and this is where the form picks which one it means. Unchanged since the modal opened is the
  // ABSENT case; anything else is what the picker holds now, with an empty picker meaning null.
  const secretRefChanged = editing ? secretTouched : true;
  // Configured, and not showable. The list says "Signed" for this channel; without a sentence here
  // the modal would say "None" and read as a bug worth "fixing".
  const secretUnshowable = !!editing?.hasSecret && !secretRef && !secretTouched;

  // What the inputs hold right now, in the server's vocabulary. `url` is omitted on an edit that
  // leaves it blank, which is how "keep the stored one" is spelled on the wire.
  const currentOf = () => {
    const body: Record<string, unknown> = {
      name,
      type,
      minLevel,
      stages: allStagesChecked ? [] : [...stages],
      excludeAgentIds: [...excluded],
      enabled,
    };
    if (secretRefChanged) body.secretRef = secretRef.trim() || null;
    if (!editing || url.trim()) body.url = url.trim();
    return body;
  };
  const currentRef = useRef(currentOf());
  currentRef.current = currentOf();

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    const sent = currentOf();
    const held = (e: unknown) =>
      refusal.capture(
        e,
        t("alerts.saveFailed", "Could not save the channel"),
        sent,
        currentRef.current,
      ) ?? "";
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
          excludeAgentIds: [...excluded],
          enabled,
        };
        if (secretRefChanged) patch.secretRef = ref;
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
            excludeAgentIds: [...excluded],
            secretRef: ref,
            enabled,
          })
        ).error;
      }
      if (apiError) {
        setError(held(apiError));
        return;
      }
      refusal.clear();
      onSaved();
      modal.close();
    } catch (e) {
      // Through `held` like the branch above, and not because the sentence changes — the fallback IS
      // this sentence. It is the CHANNEL: `error` is drawn inside the dialog, and the operator can
      // dismiss one while its save is out (docs/modals.md), after which this line reaches nobody.
      // `capture` is what knows the form has gone and sends the words somewhere still on screen.
      setError(held(e));
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
            error={!!refusal.at("name", name)}
            errorMessage={refusal.at("name", name) ?? undefined}
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
          {refusal.at("type", type) && (
            <p className="mt-1 text-error text-xs">
              {refusal.at("type", type)}
            </p>
          )}
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
            error={!!refusal.at("url", url.trim())}
            errorMessage={refusal.at("url", url.trim()) ?? undefined}
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

        <fieldset>
          <legend className={labelCls}>
            {t("alerts.excludeAgents", "Agents that never alert here")}
          </legend>
          <p className="mb-2 text-text-muted text-xs">
            {t(
              "alerts.excludeAgentsHint",
              "Their warnings and errors still appear in Logs; only this channel skips them. Use it for test agents that share the instance with production.",
            )}
          </p>
          {agentsFailed ? (
            <p className="text-error text-xs">
              {t(
                "alerts.excludeAgentsLoadFailed",
                "Could not load the agents. The current list is kept as it is.",
              )}
            </p>
          ) : !agentOptions ? (
            <p className="text-text-muted text-xs">
              {t("common.loading", "Loading…")}
            </p>
          ) : agentOptions.length === 0 && staleExcluded.length === 0 ? (
            <p className="text-text-muted text-xs">
              {t("alerts.excludeAgentsEmpty", "No agents yet.")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {agentOptions.map((a) => {
                const checked = excluded.has(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    disabled={loading}
                    aria-pressed={checked}
                    onClick={() => toggleExcluded(a.id)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      {
                        "border-accent bg-accent-soft text-text-primary":
                          checked,
                        "border-border text-text-secondary hover:bg-bg-hover":
                          !checked,
                      },
                    )}
                  >
                    {a.name}
                  </button>
                );
              })}
              {staleExcluded.map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={loading}
                  aria-pressed={true}
                  onClick={() => toggleExcluded(id)}
                  className="rounded-full border border-accent bg-accent-soft px-2.5 py-1 text-text-primary text-xs"
                >
                  {t("alerts.excludedDeletedAgent", "Deleted agent #{{id}}", {
                    id,
                  })}
                </button>
              ))}
            </div>
          )}
        </fieldset>

        {type === "webhook" && (
          <FormField
            label={t("alerts.secretRef", "Signing secret (optional)")}
            group
            error={refusal.at("secretRef", secretRef.trim() || null)}
            description={
              secretUnshowable
                ? t(
                    "alerts.secretRefOpaque",
                    "A signing secret is set but does not point at a credential in the vault, so deliveries go unsigned and it cannot be shown. Pick a credential to sign again, or clear it.",
                  )
                : t(
                    "alerts.secretRefHint",
                    "Signs each delivery (HMAC) so your endpoint can verify it. Leave blank for unsigned. Discord ignores this.",
                  )
            }
          >
            <CredentialPicker
              value={secretRef}
              onChange={(v) => {
                setSecretTouched(true);
                setSecretRef(v);
              }}
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

// What the channel DOES, never what the column holds. This used to rebuild the worker's rule out of
// `type` + `hasSecret` + `secretRef`, and got three of the four cases right; the server now answers
// the whole question in one field (issue #724), because the fourth needs the VAULT and no per-row
// projection can grow that. A well-formed ref whose entry was deleted, or created and never filled,
// resolves to nothing in `alert-send.ts` and the alert goes out unsigned — and this line said
// "Signed" for it, which is worse than saying nothing: it is the screen an operator checks precisely
// when they suspect the receiver is dropping deliveries.
//
// The last three read the same on the wire and differ only in the errand, so they get three
// sentences rather than one: a vault page to visit, a credential to recreate, a value to fill in.
function signingLabel(
  ch: { signingState: string },
  t: (k: string, d: string) => string,
): string {
  switch (ch.signingState) {
    case "signed":
      return ` · ${t("alerts.signed", "Signed")}`;
    case "ignored":
      return ` · ${t("alerts.signedIgnored", "Signing secret ignored on this channel type")}`;
    case "unreadable":
      return ` · ${t("alerts.signedUnavailable", "Signing secret set, but its credential is not in the vault: deliveries go unsigned")}`;
    case "missing":
      return ` · ${t("alerts.signedDeleted", "Signing credential was deleted: deliveries go unsigned")}`;
    case "pending":
      return ` · ${t("alerts.signedPending", "Signing credential has no value yet: deliveries go unsigned")}`;
    default:
      return "";
  }
}

const ALERT_FIELDS = ["name", "type", "url"] as const;

// The signing secret belongs to a webhook, and its picker is drawn only there. It can still reach the
// BODY from a dialog showing no picker: an operator who picks a credential and then switches to
// Discord in the same save sends a ref that MOVED, stranded — so the server can still refuse it by
// name, and the field has to be listed for that refusal to be placeable. A ref the operator never
// touched is omitted instead, so switching type leaves the stored one alone rather than clearing it.
const ALERT_WEBHOOK_FIELDS = [...ALERT_FIELDS, "secretRef"] as const;

export function AlertChannelsSection() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const modal = useModalController<ChannelModalPayload>();
  const confirm = useModalController<ConfirmPayload>();
  // A SET, not the one id the webhooks list next door holds, and the reason is this feature's own
  // subject (review round 1 of #605). With a single id, testing channel B while A is still in flight
  // re-enables A's button, and whichever request finishes FIRST clears the spinner on the other while
  // it is still running. Both halves cost a real external send: an enabled button invites a second
  // POST to a destination that has not answered the first, and a button that says idle while it is
  // working is a console lying about a delivery — which is the exact failure this PR exists to stop,
  // one screen up.
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const startTesting = (id: string) =>
    setTesting((prev) => new Set(prev).add(id));
  const doneTesting = (id: string) =>
    setTesting((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

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

  // The button the issue is named after (#605): before it, the only way to learn whether a channel
  // was wired correctly was to wait for an incident and watch it not arrive.
  const runTest = async (ch: AlertChannel) => {
    startTesting(ch.id);
    try {
      const { data, error: err } = await api.api.v1["alert-channels"]({
        id: ch.id,
      }).test.post();
      const result = data?.result;
      if (err || !result) {
        showToast(
          apiErrorMessage(err) || t("alerts.testFailed", "Test alert failed"),
          "error",
        );
        return;
      }
      if (!result.ok) {
        // A 200 carrying the DESTINATION's refusal, not a refusal of ours: `err` is null by the
        // guard above, and `result.error` is the reason. Saying only "failed" here would reproduce
        // the issue one level up, with the operator unable to tell a bad URL from a dead endpoint.
        showToast(
          t("alerts.testFailedReason", "Test failed: {{reason}}", {
            reason: result.error ?? String(result.status ?? "unknown"),
          }),
          "error",
        );
        return;
      }
      // Delivered, and then the two things a bare success would let the operator believe wrongly:
      // that the channel is already watching, and that it is signing.
      if (result.warning) {
        showToast(
          t(
            "alerts.testDeliveredUnsigned",
            "Delivered ({{status}}), but UNSIGNED: the configured signing secret did not resolve",
            { status: result.status ?? 200 },
          ),
          "warning",
        );
        return;
      }
      showToast(
        result.enabled
          ? t("alerts.testDelivered", "Test alert delivered ({{status}})", {
              status: result.status ?? 200,
            })
          : t(
              "alerts.testDeliveredDisabled",
              "Test alert delivered ({{status}}), but this channel is still disabled",
              { status: result.status ?? 200 },
            ),
        result.enabled ? "success" : "info",
      );
    } catch {
      showToast(t("alerts.testFailed", "Test alert failed"), "error");
    } finally {
      doneTesting(ch.id);
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
                  {ch.excludeAgentIds.length > 0 && " · "}
                  {ch.excludeAgentIds.length > 0 &&
                    t("alerts.excludedCount", "{{count}} agents excluded", {
                      count: ch.excludeAgentIds.length,
                    })}
                  {signingLabel(ch, t)}
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
                  loading={testing.has(ch.id)}
                  disabled={testing.has(ch.id)}
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
