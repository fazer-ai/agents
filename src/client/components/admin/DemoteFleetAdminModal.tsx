import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import {
  Modal,
  ModalCancelButton,
  type ModalController,
  useOnModalOpen,
} from "@/client/components/Modal";
import { RoleBadge } from "@/client/components/RoleBadge";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

// Removing the FLEET grant. It is separate from the tenant grants a person holds: someone who already
// belongs to a tenant just loses the fleet role and keeps those memberships as they are, which the
// dialog lists. Only a person with no membership (made at `/setup` or by a fleet invitation) is asked
// for a tenant and a role, since an account with none has nowhere to sign in to. The memberships come
// with the fleet row of the users list; the server decides either way.
type Membership = { tenantId: string; role: string };

export interface DemoteTarget {
  id: string;
  email: string;
  memberships: Membership[];
}

const selectCls =
  "w-full rounded-md border border-border-hover bg-bg-tertiary h-8 px-2.5 text-sm text-text-primary transition-colors focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-accent-soft";
const labelCls = "mb-1 block font-medium text-sm text-text-primary";

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
  const [role, setRole] = useState<"AGENT" | "TENANT_ADMIN">("AGENT");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const target = modal.payload;
  const tenantName = new Map(tenants.map((tn) => [tn.id, tn.name]));

  const memberships = target?.memberships ?? [];
  const sessionRef = useRef(0);

  useOnModalOpen(modal, () => {
    sessionRef.current += 1;
    setTenantId("");
    setRole("AGENT");
    setError("");
    setLoading(false);
  });

  const needsTenant = memberships.length === 0;

  const handleSubmit = async () => {
    if (!target || (needsTenant && !tenantId)) return;
    const session = sessionRef.current;
    setError("");
    setLoading(true);
    try {
      const { error: apiError } = await api.api.admin
        .users({ id: target.id })
        .role.patch(
          needsTenant
            ? { role, tenantId, demoteFleet: true }
            : { role: "AGENT", demoteFleet: true },
        );
      if (session !== sessionRef.current) return;
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
      if (session === sessionRef.current) setLoading(false);
    }
  };

  return (
    <Modal
      modal={modal}
      title={t("admin.removeSuperAdmin", "Remove super admin")}
      size="md"
      onCloseRequest={loading ? () => {} : undefined}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading) void handleSubmit();
        }}
      >
        {error && (
          <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
            {error}
          </div>
        )}
        {needsTenant ? (
          <>
            <p className="text-sm text-text-secondary">
              {t(
                "admin.removeSuperAdminNoTenant",
                "{{email}} stops administering the whole installation. They belong to no tenant yet, so choose where they stay and with which role.",
                { email: target?.email ?? "" },
              )}
            </p>
            <div>
              <label htmlFor="demote-tenant" className={labelCls}>
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
            <div>
              <label htmlFor="demote-role" className={labelCls}>
                {t("invite.role", "Role")}
              </label>
              <select
                id="demote-role"
                className={selectCls}
                value={role}
                disabled={loading}
                onChange={(e) =>
                  setRole(e.target.value as "AGENT" | "TENANT_ADMIN")
                }
              >
                <option value="AGENT">{t("role.agent", "Agent")}</option>
                <option value="TENANT_ADMIN">
                  {t("role.tenantAdmin", "Tenant admin")}
                </option>
              </select>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-text-secondary">
              {t(
                "admin.removeSuperAdminKeeps",
                "{{email}} stops administering the whole installation and keeps the access they already have:",
                { email: target?.email ?? "" },
              )}
            </p>
            <ul className="space-y-1.5">
              {memberships.map((m) => (
                <li
                  key={m.tenantId}
                  className="flex items-center justify-between gap-2 text-sm text-text-primary"
                >
                  <span>{tenantName.get(m.tenantId) ?? m.tenantId}</span>
                  <RoleBadge role={m.role} />
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex justify-end gap-2">
          <ModalCancelButton disabled={loading} />
          <Button
            type="submit"
            variant="danger"
            disabled={loading || (needsTenant && !tenantId)}
            loading={loading}
          >
            {t("admin.removeSuperAdmin", "Remove super admin")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
