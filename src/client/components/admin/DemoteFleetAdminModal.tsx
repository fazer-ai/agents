import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import {
  Modal,
  type ModalController,
  useOnModalOpen,
} from "@/client/components/Modal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

// Demoting a FLEET administrator, which is not the same act as demoting a tenant's admin. A fleet
// administrator belongs to no tenant and everybody else belongs to one, so taking the fleet role
// away has to say where the person lands — the server refuses a demotion that names no tenant, and
// this dialog is what lets the operator answer it (#534). A tenant admin's demote stays one click:
// they already have a tenant, and nothing about it changes.
export interface DemoteTarget {
  id: string;
  email: string;
}

const selectCls =
  "w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-text-primary focus:border-border-focus focus:outline-none";

export function DemoteFleetAdminModal({
  modal,
  tenants,
  onDemoted,
}: {
  modal: ModalController<DemoteTarget>;
  tenants: { id: string; name: string }[];
  onDemoted: () => void;
}) {
  const { t } = useTranslation();
  const [tenantId, setTenantId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const target = modal.payload;
  // One token per open. The dialog outlives its own request: closing and reopening it for a DIFFERENT
  // administrator while the first PATCH is in flight would otherwise let that reply write its error
  // onto the new session, or close a dialog the operator had just opened. `docs/modals.md`.
  const session = useRef(0);

  useOnModalOpen(modal, () => {
    session.current += 1;
    setTenantId("");
    setError("");
    setLoading(false);
  });

  const handleSubmit = async () => {
    if (!target || !tenantId) return;
    const mine = session.current;
    setError("");
    setLoading(true);
    try {
      const { error: apiError } = await api.api.admin
        .users({ id: target.id })
        .role.patch({ role: "AGENT", tenantId });
      if (session.current !== mine) return;
      if (apiError) {
        setError(
          apiErrorMessage(apiError) ||
            t("admin.roleUpdateFailed", "Failed to update role"),
        );
        return;
      }
      onDemoted();
      modal.close();
    } finally {
      if (session.current === mine) setLoading(false);
    }
  };

  return (
    <Modal
      modal={modal}
      title={t("admin.demoteFleetAdmin", "Demote fleet administrator")}
      size="md"
      // While the write is in flight the dialog does not take a close from Escape, the backdrop or
      // the X either: the buttons being disabled covers only the buttons, and a dismissal here is
      // what leaves the operator with no idea whether the demotion happened.
      onCloseRequest={loading ? () => {} : undefined}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading && tenantId) void handleSubmit();
        }}
      >
        {error && (
          <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
            {error}
          </div>
        )}
        <p className="text-sm text-text-secondary">
          {t(
            "admin.demoteFleetAdminHint",
            "{{email}} administers the whole fleet and belongs to no tenant. Demoting them makes them a user of one tenant, which you choose here.",
            { email: target?.email ?? "" },
          )}
        </p>
        <div>
          <label
            htmlFor="demote-tenant"
            className="mb-1 block font-medium text-sm text-text-primary"
          >
            {t("invite.tenant", "Tenant")}
          </label>
          <select
            id="demote-tenant"
            className={selectCls}
            value={tenantId}
            disabled={loading}
            onChange={(e) => setTenantId(e.target.value)}
          >
            <option value="">{t("tenant.select", "Select tenant")}</option>
            {tenants.map((tn) => (
              <option key={tn.id} value={tn.id}>
                {tn.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={modal.close} disabled={loading}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            type="submit"
            disabled={loading || !tenantId}
            loading={loading}
          >
            {t("admin.demote", "Demote")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
