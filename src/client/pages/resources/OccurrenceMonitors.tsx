import { Activity, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  DataBoundary,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  useModalController,
  useOnModalOpen,
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

export type NamePayload = {
  title: string;
  name: string;
  action: string;
  // What the action does with the name, under the title.
  description?: string;
};

// The name form, for New and Duplicate: the refusal (a name already taken, the account at its limit)
// stays in the form, so the operator reads it where they typed.
export function NameModal({
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
      description={payload?.description}
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
// own themes. A row says whether it is on, what it reads and when it last ran, and opens it; New
// takes a name. Renaming, duplicating and deleting a monitor happen in its own view.
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
  const nameModal = useModalController<NamePayload>();
  const inboxName = (id: string) => {
    if (inboxes === null)
      return t("occurrences.monitors.inboxById", "Inbox {{id}}", { id });
    const i = inboxes.find((x) => x.id === id);
    return i
      ? inboxOptionLabel(i, t)
      : t("occurrences.inboxes.removed", "An inbox removed from this account");
  };

  async function submitName(name: string): Promise<string | null> {
    const res = await api.api.v1.occurrences.monitors.post({ name });
    if (res.error) {
      return (
        apiErrorMessage(res.error) ||
        t("occurrences.monitors.saveError", "Could not save the monitor.")
      );
    }
    nameModal.close();
    await onChanged();
    return null;
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
              <button
                type="button"
                onClick={() => onOpen(m.id)}
                className="group w-full min-w-0 rounded-lg border border-border bg-bg-secondary p-5 text-left transition-colors hover:bg-bg-tertiary"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-text-primary group-hover:text-accent">
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
            </li>
          ))}
        </ul>
      </DataBoundary>
      <NameModal modal={nameModal} onSubmit={submitName} />
    </div>
  );
}
