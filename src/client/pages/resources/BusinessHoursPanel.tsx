import { Clock, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  Modal,
  useModalController,
  useToast,
} from "@/client/components";
import { BusinessHoursForm } from "@/client/components/BusinessHoursForm";
import { api } from "@/client/lib/api";
import { formatWindowsSummary } from "@/client/lib/schedulePreview";
import { formatTimezoneLabel } from "@/client/lib/timezones";

type HoursData = Awaited<
  ReturnType<(typeof api.api.v1)["business-hours"]["get"]>
>["data"];
type Hours = NonNullable<HoursData>["businessHours"][number];

export function BusinessHoursPanel() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [items, setItems] = useState<Hours[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // editModal payload: undefined = create, string id = update
  const editModal = useModalController<{ id?: string }>();
  const confirm = useModalController<ConfirmPayload>();

  // Track which item is being edited to pass initial values to the form.
  const [editingItem, setEditingItem] = useState<Hours | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1["business-hours"].get();
      if (err || !data) {
        setError(true);
        return;
      }
      setItems(data.businessHours);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditingItem(null);
    editModal.open({});
  }

  function openEdit(h: Hours) {
    setEditingItem(h);
    editModal.open({ id: h.id });
  }

  function askDelete(h: Hours) {
    confirm.open({
      title: t("hours.deleteTitle", "Delete business hours"),
      message: t("hours.deleteMessage", 'Delete "{{name}}"?', { name: h.name }),
      danger: true,
      confirmLabel: t("common.delete", "Delete"),
      onConfirm: async () => {
        const { error: err } = await api.api.v1["business-hours"]({
          id: h.id,
        }).delete();
        if (err) {
          showToast(t("hours.deleteError", "Could not delete."), "error");
          throw err;
        }
        showToast(t("hours.deleted", "Deleted."), "success");
        load();
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {t(
            "hours.subtitle",
            "Weekly availability windows. Follow-ups and proactive actions respect these.",
          )}
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("hours.add", "New schedule")}
        </Button>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={items.length === 0}
        onRetry={load}
        empty={
          <EmptyState
            icon={Clock}
            title={t("hours.emptyTitle", "No schedules yet")}
            description={t(
              "hours.emptyDesc",
              "Define when your agents are available to respond.",
            )}
          />
        }
      >
        <div className="flex flex-col gap-3">
          {items.map((h) => (
            <Card
              key={h.id}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-text-primary">
                    {h.name}
                  </span>
                  <Badge variant="secondary">
                    {formatTimezoneLabel(h.timezone)}
                  </Badge>
                  {h.source === "CHATWOOT_MIRROR" && (
                    <Badge variant="info">
                      {t("hours.mirror", "Mirrored")}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-text-muted text-xs">
                  {formatWindowsSummary(
                    h.windows,
                    t("hours.noWindows", "No windows"),
                    i18n.language,
                  )}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openEdit(h)}
                >
                  {t("common.edit", "Edit")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => askDelete(h)}
                  aria-label={t("common.delete", "Delete")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </DataBoundary>

      {/* BusinessHoursForm uses useUnsavedChanges internally — no unsavedChanges prop needed here */}
      <Modal
        modal={editModal}
        size="lg"
        title={
          editModal.payload?.id
            ? t("hours.editTitle", "Edit schedule")
            : t("hours.addTitle", "New schedule")
        }
      >
        <BusinessHoursForm
          mode={editModal.payload?.id ? "update" : "create"}
          initial={
            editingItem
              ? {
                  id: editingItem.id,
                  name: editingItem.name,
                  timezone: editingItem.timezone,
                  windows: editingItem.windows.map((w) => ({ ...w })),
                  exceptions: editingItem.exceptions.map((e) => ({
                    ...e,
                    ranges: e.ranges.map((r) => ({ ...r })),
                  })),
                }
              : undefined
          }
          onSaved={() => {
            editModal.close();
            void load();
          }}
          onCancel={() => editModal.close()}
        />
      </Modal>

      <ConfirmDialog modal={confirm} />
    </div>
  );
}
