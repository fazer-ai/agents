import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { FormField } from "./FormField";
import { Input } from "./Input";
import { Modal, type ModalController } from "./Modal";

export interface StrongConfirmPayload {
  title: string;
  // Red warning box (what gets destroyed). Keep it explicit and irreversible-sounding.
  warning: string;
  // Optional muted backup hint shown under the warning.
  backupNote?: string;
  // The exact phrase the operator must re-type (domain / tenant name / user email).
  confirmPhrase: string;
  // Label for the type-to-confirm field (e.g. "Type {{name}} to confirm").
  confirmLabel: string;
  confirmPlaceholder?: string;
  // Danger button label.
  actionLabel: string;
  // Awaited with the typed step-up password; the dialog shows a busy state until it settles, then
  // closes. Throw to keep it open on failure (the caller surfaces its own error toast); the dialog
  // swallows the throw, since the click handler is the only awaiter.
  onConfirm: (password: string) => void | Promise<void>;
}

// Reusable strong-confirmation modal for destructive, hard-to-reverse actions: a backup warning, a
// re-type-the-name field, and a step-up password, mirroring the Chatwoot teardown.
// Mount one `<StrongConfirmModal modal={...} />` per page (render-always — never gate it behind a
// conditional, see docs/modals.md) and open it with a payload.
export function StrongConfirmModal({
  modal,
}: {
  modal: ModalController<StrongConfirmPayload>;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const payload = modal.payload;

  // Clear the fields whenever a new confirmation is opened (payload identity changes per open()).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on each distinct payload
  useEffect(() => {
    setTyped("");
    setPassword("");
  }, [payload]);

  const canConfirm =
    !!payload && typed.trim() === payload.confirmPhrase && password.length > 0;

  async function handleConfirm() {
    if (!payload || !canConfirm) return;
    setBusy(true);
    try {
      await payload.onConfirm(password);
      modal.close();
    } catch {
      // NOTE: the caller already showed why; staying open is the whole response.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      modal={modal}
      size="sm"
      unsavedChanges={typed.trim() !== "" || password !== ""}
      title={payload?.title ?? ""}
      busy={busy}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => modal.close()}
            disabled={busy}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            loading={busy}
            disabled={!canConfirm}
          >
            {payload?.actionLabel ?? t("common.confirm", "Confirm")}
          </Button>
        </div>
      }
    >
      {payload && (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-error bg-bg-tertiary p-3 text-error text-sm">
            {payload.warning}
          </div>
          {payload.backupNote && (
            <p className="text-sm text-text-muted">{payload.backupNote}</p>
          )}
          <FormField label={payload.confirmLabel} required>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={payload.confirmPlaceholder ?? payload.confirmPhrase}
              autoComplete="off"
            />
          </FormField>
          <FormField
            label={t("strongConfirm.password", "Your password")}
            required
          >
            <Input
              type="password"
              showPasswordToggle
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </FormField>
        </div>
      )}
    </Modal>
  );
}
