import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Modal, type ModalController } from "./Modal";

export interface ConfirmPayload {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  // Awaited; the dialog shows a busy state until it settles, then closes. Throw
  // to keep the dialog open on failure (the caller surfaces its own error toast).
  onConfirm: () => void | Promise<void>;
}

// Reusable confirm modal driven by a payload-carrying controller. Open with
// `confirm.open({ title, message, danger, onConfirm })`. Mount one
// `<ConfirmDialog modal={confirm} />` per page (render-always — never gate it
// behind a conditional, see docs/modals.md).
export function ConfirmDialog({
  modal,
}: {
  modal: ModalController<ConfirmPayload>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const payload = modal.payload;

  async function handleConfirm() {
    if (!payload) return;
    setBusy(true);
    try {
      await payload.onConfirm();
      modal.close();
    } finally {
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
          <Button
            variant="secondary"
            onClick={() => modal.close()}
            disabled={busy}
          >
            {payload?.cancelLabel ?? t("common.cancel", "Cancel")}
          </Button>
          <Button
            variant={payload?.danger ? "danger" : "primary"}
            onClick={handleConfirm}
            loading={busy}
          >
            {payload?.confirmLabel ?? t("common.confirm", "Confirm")}
          </Button>
        </div>
      }
    >
      {payload?.message && (
        <p className="text-sm text-text-secondary">{payload.message}</p>
      )}
    </Modal>
  );
}
