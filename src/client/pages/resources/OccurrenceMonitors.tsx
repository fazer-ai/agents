import { Activity, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { inboxOptionLabel } from "@/client/lib/inboxOption";
import { formatRelativeTime } from "@/client/lib/utils";
import type { InboxOption } from "./OccurrenceInboxes";

type MonitorsData = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.occurrences.monitors.get>>["data"]
>;
export type MonitorView = MonitorsData["monitors"][number];

type NamePayload = {
  title: string;
  name: string;
  action: string;
  // The monitor being renamed; absent for New.
  renaming?: string;
};

// The name form, for New and Rename: the refusal (a name already taken, the account at its limit)
// stays in the form, so the operator reads it where they typed.
function NameModal({
  modal,
  onSubmit,
}: {
  modal: ModalController<NamePayload>;
  onSubmit: (name: string) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const payload = modal.payload;
  useOnModalOpen(modal, () => {
    setName(modal.payload?.name ?? "");
    setError(null);
  });
  // A second Enter while the save is on the wire is not a second save: the input stays enabled, so
  // the guard is a ref, which holds before `busy` re-renders.
  const pending = useRef(false);
  // A refusal belongs to the name it refused: one that lands after the name was changed is dropped.
  const current = useRef(name);
  current.current = name;
  async function submit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const sent = name.trim();
    try {
      const refusal = await onSubmit(sent);
      if (current.current.trim() === sent) setError(refusal);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      modal={modal}
      size="sm"
      title={payload?.title ?? ""}
      busy={busy}
      footer={
        <div className="flex justify-end gap-2">
          <ModalCancelButton disabled={busy} />
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={name.trim() === ""}
          >
            {payload?.action ?? ""}
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== "") void submit();
        }}
      >
        <FormField label={t("occurrences.monitors.name", "Name")} error={error}>
          <Input
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </FormField>
      </form>
    </Modal>
  );
}

// The account's occurrence monitors (docs/occurrences.md): each one reads its own inboxes into its
// own themes. A row says whether it is on, what it reads and when it last ran, and opens it; New,
// Rename, Duplicate (the configuration only, off and with no inboxes) and Delete (confirmed on the
// page, with what goes with it) act on the list.
export function OccurrenceMonitors({
  monitors,
  max,
  inboxes,
  loading,
  failed,
  onRetry,
  onOpen,
  onChanged,
}: {
  monitors: MonitorView[];
  max: number;
  inboxes: InboxOption[] | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const nameModal = useModalController<NamePayload>();
  const confirm = useModalController<ConfirmPayload>();
  // A refusal of an action taken from the list (Duplicate at the limit), kept on the page.
  const [listError, setListError] = useState<string | null>(null);

  const inboxName = (id: string) => {
    if (inboxes === null)
      return t("occurrences.monitors.inboxById", "Inbox {{id}}", { id });
    const i = inboxes.find((x) => x.id === id);
    return i
      ? inboxOptionLabel(i, t)
      : t("occurrences.inboxes.removed", "An inbox removed from this account");
  };

  async function submitName(name: string): Promise<string | null> {
    const renaming = nameModal.payload?.renaming;
    const res = renaming
      ? await api.api.v1.occurrences.monitors({ id: renaming }).patch({ name })
      : await api.api.v1.occurrences.monitors.post({ name });
    if (res.error) {
      return (
        apiErrorMessage(res.error) ||
        t("occurrences.monitors.saveError", "Could not save the monitor.")
      );
    }
    nameModal.close();
    setListError(null);
    await onChanged();
    return null;
  }

  async function duplicate(m: MonitorView) {
    setListError(null);
    const res = await api.api.v1.occurrences
      .monitors({ id: m.id })
      .duplicate.post({});
    if (res.error) {
      const message =
        apiErrorMessage(res.error) ||
        t(
          "occurrences.monitors.duplicateError",
          "Could not duplicate the monitor.",
        );
      setListError(message);
      showToast(message, "error");
      return;
    }
    showToast(
      t(
        "occurrences.monitors.duplicated",
        "Copy created, off and with no inboxes.",
      ),
      "success",
    );
    await onChanged();
  }

  function askDelete(m: MonitorView) {
    confirm.open({
      title: t("occurrences.monitors.deleteTitle", "Delete monitor"),
      message:
        m.openThemes === 0 && m.runs === 0
          ? t(
              "occurrences.monitors.deleteMessageEmpty",
              'Delete "{{name}}"? It has no themes or rounds yet. This cannot be undone.',
              { name: m.name },
            )
          : t(
              "occurrences.monitors.deleteMessage",
              'Delete "{{name}}"? Its {{themes}} open themes and {{runs}} rounds go with it, and it stops running. This cannot be undone.',
              { name: m.name, themes: m.openThemes, runs: m.runs },
            ),
      danger: true,
      confirmLabel: t("common.delete", "Delete"),
      onConfirm: async () => {
        const res = await api.api.v1.occurrences
          .monitors({ id: m.id })
          .delete();
        if (res.error) {
          showToast(
            apiErrorMessage(res.error) ||
              t(
                "occurrences.monitors.deleteError",
                "Could not delete the monitor.",
              ),
            "error",
          );
          throw res.error;
        }
        showToast(t("occurrences.monitors.deleted", "Deleted."), "success");
        setListError(null);
        await onChanged();
      },
    });
  }

  const create = (
    <Button
      size="sm"
      onClick={() =>
        nameModal.open({
          title: t("occurrences.monitors.newTitle", "New monitor"),
          name: "",
          action: t("occurrences.monitors.create", "Create"),
        })
      }
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
      {t("occurrences.monitors.new", "New monitor")}
    </Button>
  );

  const lastRun = (m: MonitorView) => {
    if (!m.lastRun) return t("occurrences.monitors.neverRan", "no round yet");
    if (m.lastRun.status === "running")
      return t("occurrences.monitors.running", "round running");
    const when = formatRelativeTime(
      m.lastRun.finishedAt ?? m.lastRun.startedAt,
      i18n.language,
    );
    return m.lastRun.status === "failed"
      ? t("occurrences.monitors.lastFailed", "last round failed {{when}}", {
          when,
        })
      : t("occurrences.monitors.lastRun", "last round {{when}}", { when });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {t(
            "occurrences.monitors.intro",
            "Each monitor reads its own inboxes and groups the same reasons into its own themes. Up to {{max}} per account.",
            { max },
          )}
        </p>
        {create}
      </div>
      {listError && (
        <p role="alert" className="text-error text-sm">
          {listError}
        </p>
      )}
      {inboxes === null && !loading && !failed && monitors.length > 0 && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-error">
            {t(
              "occurrences.monitors.inboxesFailed",
              "Could not read the account's inboxes, so they are named by number.",
            )}
          </span>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t("common.retry", "Retry")}
          </Button>
        </div>
      )}
      <DataBoundary
        loading={loading}
        error={failed}
        onRetry={onRetry}
        isEmpty={monitors.length === 0}
        empty={
          <EmptyState
            icon={Activity}
            title={t("occurrences.monitors.emptyTitle", "No monitor yet")}
            description={t(
              "occurrences.monitors.emptyDescription",
              "Create one, choose the inboxes it reads and switch it on.",
            )}
            action={create}
          />
        }
      >
        <ul className="flex flex-col gap-3">
          {monitors.map((m) => (
            <li key={m.id}>
              <Card className="flex flex-wrap items-center justify-between gap-4">
                <button
                  type="button"
                  onClick={() => onOpen(m.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-text-primary hover:text-accent">
                      {m.name}
                    </span>
                    <Badge variant={m.enabled ? "success" : "secondary"}>
                      {m.enabled
                        ? t("occurrences.monitors.on", "on")
                        : t("occurrences.monitors.off", "off")}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-text-muted text-xs">
                    {m.inboxIds.length === 0
                      ? t("occurrences.monitors.noInboxes", "no inboxes")
                      : m.inboxIds.map(inboxName).join(", ")}
                    {" · "}
                    {lastRun(m)}
                  </p>
                </button>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      nameModal.open({
                        title: t(
                          "occurrences.monitors.renameTitle",
                          "Rename monitor",
                        ),
                        name: m.name,
                        action: t("occurrences.monitors.rename", "Rename"),
                        renaming: m.id,
                      })
                    }
                    aria-label={t("occurrences.monitors.rename", "Rename")}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void duplicate(m)}
                    aria-label={t(
                      "occurrences.monitors.duplicate",
                      "Duplicate",
                    )}
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => askDelete(m)}
                    aria-label={t("common.delete", "Delete")}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </DataBoundary>
      <NameModal modal={nameModal} onSubmit={submitName} />
      <ConfirmDialog modal={confirm} />
    </div>
  );
}
