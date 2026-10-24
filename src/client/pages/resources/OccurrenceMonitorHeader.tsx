import { ArrowLeft, Copy, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  Input,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { clipText } from "@/lib/text";
import {
  type MonitorView,
  NameModal,
  type NamePayload,
} from "./OccurrenceMonitors";

// The name the copy is offered under, cut to the longest name a monitor can have.
const MONITOR_NAME_MAX = 80;

// The open monitor's header (docs/occurrences.md): the way back to the list, the name, edited in
// place, and the actions on the monitor itself. Duplicate asks for the copy's name and says what the
// copy carries; Delete asks on the page with what goes with it.
export function OccurrenceMonitorHeader({
  monitor,
  onBack,
  onRenamed,
  onDuplicated,
  onDeleted,
  onNameDirtyChange,
}: {
  monitor: MonitorView;
  onBack: () => void;
  onRenamed: () => void;
  onDuplicated: (copy: MonitorView) => void;
  onDeleted: () => void;
  onNameDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const copyModal = useModalController<NamePayload>();
  const confirm = useModalController<ConfirmPayload>();
  // The saved name, ahead of the list's next read, so the header never shows the old one meanwhile.
  const [saved, setSaved] = useState(monitor.name);
  useEffect(() => setSaved(monitor.name), [monitor.name]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(monitor.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A second Enter while the save is on the wire is not a second save.
  const pending = useRef(false);
  // A name typed and not saved is an unsaved edit like the configuration's, which the view guards.
  const nameDirty = editing && draft.trim() !== saved;
  useEffect(() => onNameDirtyChange(nameDirty), [nameDirty, onNameDirtyChange]);

  const startEdit = () => {
    setDraft(saved);
    setError(null);
    setEditing(true);
  };

  async function saveName() {
    const name = draft.trim();
    if (name === "" || pending.current) return;
    if (name === saved) {
      setEditing(false);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const res = await api.api.v1.occurrences
        .monitors({ id: monitor.id })
        .patch({ name });
      if (res.error) {
        setError(
          apiErrorMessage(res.error) ||
            t("occurrences.monitors.saveError", "Could not save the monitor."),
        );
        return;
      }
      setSaved(name);
      setEditing(false);
      void onRenamed();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const askCopy = () =>
    copyModal.open({
      title: t("occurrences.monitors.duplicateTitle", "Duplicate monitor"),
      name: clipText(
        t("occurrences.monitors.copyName", "Copy of {{name}}", {
          name: saved,
        }),
        MONITOR_NAME_MAX,
      ),
      action: t("occurrences.monitors.duplicate", "Duplicate"),
      description: t(
        "occurrences.monitors.duplicateHint",
        "The copy takes this monitor's configuration only. It starts off and with no inboxes; the themes and rounds stay with this monitor.",
      ),
    });

  async function duplicate(name: string): Promise<string | null> {
    const res = await api.api.v1.occurrences
      .monitors({ id: monitor.id })
      .duplicate.post({ name });
    if (res.error || !res.data) {
      return (
        apiErrorMessage(res.error) ||
        t(
          "occurrences.monitors.duplicateError",
          "Could not duplicate the monitor.",
        )
      );
    }
    copyModal.close();
    showToast(
      t(
        "occurrences.monitors.duplicated",
        "Copy created, off and with no inboxes.",
      ),
      "success",
    );
    onDuplicated(res.data.monitor);
    return null;
  }

  async function askDelete() {
    // The counts as they are now: rounds keep running while the monitor is open.
    const fresh = await api.api.v1.occurrences
      .monitors({ id: monitor.id })
      .get();
    const m = fresh.data?.monitor ?? monitor;
    confirm.open({
      title: t("occurrences.monitors.deleteTitle", "Delete monitor"),
      message:
        m.openThemes === 0 && m.runs === 0
          ? t(
              "occurrences.monitors.deleteMessageEmpty",
              'Delete "{{name}}"? It has no themes or rounds yet. This cannot be undone.',
              { name: saved },
            )
          : t(
              "occurrences.monitors.deleteMessage",
              'Delete "{{name}}"? Its {{themes}} open themes and {{runs}} rounds go with it, and it stops running. This cannot be undone.',
              { name: saved, themes: m.openThemes, runs: m.runs },
            ),
      danger: true,
      confirmLabel: t("common.delete", "Delete"),
      onConfirm: async () => {
        const res = await api.api.v1.occurrences
          .monitors({ id: monitor.id })
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
        onDeleted();
      },
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t("occurrences.monitors.all", "All monitors")}
        </Button>
        {editing ? (
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <div className="flex flex-col gap-1">
              <Input
                aria-label={t(
                  "occurrences.monitors.monitorName",
                  "Monitor name",
                )}
                value={draft}
                maxLength={MONITOR_NAME_MAX}
                // NOTE: read-only while the save is on the wire, so a refusal always belongs to the
                // name on screen.
                readOnly={busy}
                autoFocus
                error={error !== null}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && !busy) {
                    e.preventDefault();
                    setEditing(false);
                  }
                }}
              />
              {error && (
                <p role="alert" className="text-error text-sm">
                  {error}
                </p>
              )}
            </div>
            <Button
              type="submit"
              size="sm"
              loading={busy}
              disabled={draft.trim() === ""}
            >
              {t("common.save", "Save")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {t("common.cancel", "Cancel")}
            </Button>
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <h2 className="truncate font-medium text-text-primary">{saved}</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={startEdit}
              aria-label={t("occurrences.monitors.rename", "Rename")}
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="secondary" size="sm" onClick={askCopy}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          {t("occurrences.monitors.duplicate", "Duplicate")}
        </Button>
        <Button variant="danger" size="sm" onClick={() => void askDelete()}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {t("common.delete", "Delete")}
        </Button>
      </div>
      <NameModal modal={copyModal} onSubmit={duplicate} />
      <ConfirmDialog modal={confirm} />
    </div>
  );
}
