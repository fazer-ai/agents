import { Check, Copy, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Modal,
  ModalCancelButton,
  type ModalController,
  Textarea,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDateTime } from "@/client/lib/utils";
import { Button } from "@/client/merchant/components/ui/button";

// One broadcast's workbench: the resolved recipient list with each rendered
// body, the review gate (DRAFT <-> READY), template edits that re-render the
// still-PENDING rows, and the manual send rail. "Send" marks every PENDING
// row SENT - the operator still copies each body to the platform by hand;
// nothing posts outward from this codebase.

type BroadcastData = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.merchant.broadcasts>["get"]>
>["data"];
type Broadcast = NonNullable<BroadcastData>["broadcast"];
type Recipient = NonNullable<Broadcast["recipients"]>[number];
type BStatus = Broadcast["status"];
type RStatus = Recipient["status"];

const BROADCAST_STATUS_LABEL: Record<BStatus, string> = {
  DRAFT: "merchant.broadcasts.status.draft",
  READY: "merchant.broadcasts.status.ready",
  SENT: "merchant.broadcasts.status.sent",
};

const BROADCAST_STATUS_VARIANT: Record<
  BStatus,
  "secondary" | "primary" | "success"
> = {
  DRAFT: "secondary",
  READY: "primary",
  SENT: "success",
};

const RECIPIENT_STATUS_LABEL: Record<RStatus, string> = {
  PENDING: "merchant.broadcasts.recipientStatus.pending",
  SENT: "merchant.broadcasts.recipientStatus.sent",
  FAILED: "merchant.broadcasts.recipientStatus.failed",
};

const RECIPIENT_STATUS_VARIANT: Record<
  RStatus,
  "secondary" | "success" | "error"
> = {
  PENDING: "secondary",
  SENT: "success",
  FAILED: "error",
};

export function BroadcastDetailModal({
  modal,
  onChanged,
}: {
  modal: ModalController<{ id: string }>;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [editBody, setEditBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = modal.payload?.id;

  async function refresh(broadcastId: string) {
    setLoading(true);
    const { data, error: err } = await api.api.v1.merchant
      .broadcasts({ id: broadcastId })
      .get();
    setLoading(false);
    if (err || !data) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.broadcasts.loadFailed", "Could not load the broadcast"),
      );
      return;
    }
    setBroadcast(data.broadcast);
    setEditBody(data.broadcast.body);
  }

  useOnModalOpen(modal, () => {
    setBroadcast(null);
    setEditBody("");
    setBusy(null);
    setError(null);
    if (modal.payload) void refresh(modal.payload.id);
  });

  async function saveBody() {
    if (!id || !broadcast) return;
    setBusy("save");
    setError(null);
    const { error: err } = await api.api.v1.merchant
      .broadcasts({ id })
      .patch({ body: editBody });
    setBusy(null);
    if (err) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.broadcasts.saveFailed", "Could not save the broadcast"),
      );
      return;
    }
    await refresh(id);
    onChanged();
  }

  async function setGate(status: "DRAFT" | "READY") {
    if (!id) return;
    setBusy(`gate:${status}`);
    setError(null);
    const { error: err } = await api.api.v1.merchant
      .broadcasts({ id })
      .patch({ status });
    setBusy(null);
    if (err) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.broadcasts.saveFailed", "Could not save the broadcast"),
      );
      return;
    }
    await refresh(id);
    onChanged();
  }

  async function sendAll() {
    if (!id) return;
    setBusy("send");
    setError(null);
    const { error: err } = await api.api.v1.merchant
      .broadcasts({ id })
      .send.post({});
    setBusy(null);
    if (err) {
      setError(
        apiErrorMessage(err) ??
          t(
            "merchant.broadcasts.sendFailed",
            "Could not mark the broadcast sent",
          ),
      );
      return;
    }
    showToast(
      t(
        "merchant.broadcasts.sentToast",
        "Every pending recipient marked sent.",
      ),
      "success",
    );
    await refresh(id);
    onChanged();
  }

  async function markRecipient(recipient: Recipient, status: RStatus) {
    if (!id) return;
    setBusy(`r:${recipient.id}`);
    setError(null);
    const { error: err } = await api.api.v1.merchant
      .broadcasts({ id })
      .recipients({ rid: recipient.id })
      .patch({ status });
    setBusy(null);
    if (err) {
      setError(
        apiErrorMessage(err) ??
          t(
            "merchant.broadcasts.recipientFailed",
            "Could not update the recipient",
          ),
      );
      return;
    }
    await refresh(id);
    onChanged();
  }

  const editable = broadcast !== null && broadcast.status !== "SENT";
  const bodyDirty = broadcast !== null && editBody !== broadcast.body;

  return (
    <Modal
      modal={modal}
      title={
        broadcast?.name ?? t("merchant.broadcasts.detailTitle", "Broadcast")
      }
      description={t(
        "merchant.broadcasts.detailSubtitle",
        "Copy each rendered body to the platform by hand, then mark the row sent.",
      )}
      size="xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-2">
            {broadcast?.status === "DRAFT" && (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void setGate("READY")}
              >
                {t("merchant.broadcasts.markReady", "Mark ready")}
              </Button>
            )}
            {broadcast?.status === "READY" && (
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void setGate("DRAFT")}
              >
                {t("merchant.broadcasts.backToDraft", "Back to draft")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <ModalCancelButton />
            {editable && (
              <Button
                disabled={busy !== null || broadcast?.status !== "READY"}
                onClick={() => void sendAll()}
              >
                {busy === "send" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                {t("merchant.broadcasts.sendAll", "Mark all sent")}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {broadcast && (
          <div className="flex items-center gap-2">
            <Badge variant={BROADCAST_STATUS_VARIANT[broadcast.status]}>
              {
                // t('merchant.broadcasts.status.draft', 'Draft')
                // t('merchant.broadcasts.status.ready', 'Ready')
                // t('merchant.broadcasts.status.sent', 'Sent')
                t(
                  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in BROADCAST_STATUS_LABEL
                  BROADCAST_STATUS_LABEL[broadcast.status] ?? broadcast.status,
                  broadcast.status,
                )
              }
            </Badge>
            <span className="text-sm text-text-secondary">
              {t(
                "merchant.broadcasts.recipientSummary",
                "{{sent}} of {{total}} sent",
                {
                  sent: broadcast.sentCount,
                  total: broadcast.recipientCount,
                },
              )}
            </span>
          </div>
        )}
        {editable && broadcast && (
          <div className="flex flex-col gap-2">
            <Textarea
              value={editBody}
              rows={3}
              maxLength={4000}
              onChange={(e) => setEditBody(e.target.value)}
            />
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !bodyDirty}
                onClick={() => void saveBody()}
              >
                {busy === "save"
                  ? t("merchant.broadcasts.saving", "Saving…")
                  : t("merchant.broadcasts.saveBody", "Save template")}
              </Button>
            </div>
          </div>
        )}
        {loading && (
          <p className="text-sm text-text-secondary">
            {t("merchant.broadcasts.loading", "Loading…")}
          </p>
        )}
        {error && <p className="text-error text-sm">{error}</p>}
        {(broadcast?.recipients ?? []).map((r) => (
          <div key={r.id} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{r.authorName}</span>
                {r.authorHandle && (
                  <span className="text-muted-foreground text-xs">
                    {r.authorHandle}
                  </span>
                )}
                <Badge variant={RECIPIENT_STATUS_VARIANT[r.status]}>
                  {
                    // t('merchant.broadcasts.recipientStatus.pending', 'Pending')
                    // t('merchant.broadcasts.recipientStatus.sent', 'Sent')
                    // t('merchant.broadcasts.recipientStatus.failed', 'Failed')
                    // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in RECIPIENT_STATUS_LABEL
                    t(RECIPIENT_STATUS_LABEL[r.status] ?? r.status, r.status)
                  }
                </Badge>
                {r.sentAt && (
                  <span className="text-muted-foreground text-xs">
                    {formatDateTime(r.sentAt, i18n.language)}
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("merchant.funnel.copy", "Copy")}
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(r.body)
                      .then(() =>
                        showToast(
                          t("merchant.funnel.copied", "Copied to clipboard"),
                          "success",
                        ),
                      )
                  }
                >
                  <Copy className="size-4" />
                </Button>
                {editable && r.status !== "SENT" && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(
                      "merchant.broadcasts.markRecipientSent",
                      "Mark sent",
                    )}
                    disabled={busy !== null}
                    onClick={() => void markRecipient(r, "SENT")}
                  >
                    <Check className="size-4" />
                  </Button>
                )}
                {editable && r.status === "PENDING" && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(
                      "merchant.broadcasts.markRecipientFailed",
                      "Mark failed",
                    )}
                    disabled={busy !== null}
                    onClick={() => void markRecipient(r, "FAILED")}
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            <p className="whitespace-pre-line text-sm text-text-primary">
              {r.body}
            </p>
            {r.error && <p className="text-error text-xs">{r.error}</p>}
          </div>
        ))}
      </div>
    </Modal>
  );
}
