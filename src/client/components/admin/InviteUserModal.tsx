import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { Input } from "@/client/components/Input";
import {
  Modal,
  type ModalController,
  useOnModalOpen,
} from "@/client/components/Modal";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";

// Admin "invite user" modal. A SUPER_ADMIN picks the target tenant (pre-filled with the Users-tab
// filter selection); a TENANT_ADMIN invites into its own tenant (no tenant field). There is no
// mailer, so on success the modal shows the one-time accept link to copy and send.
const selectCls =
  "w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-text-primary focus:border-border-focus focus:outline-none";
const labelCls = "mb-1 block font-medium text-sm text-text-primary";

// The keys of the body this modal writes. `email` is the one that matters in practice: inviting an
// address that already has an account answers 409 "Email already in use", and it names the field.
const INVITE_FIELDS = ["email", "role"] as const;

// The tenant picker is only drawn for a SUPER_ADMIN; everyone else invites into their own tenant and
// the id still rides along in the body, so the server can refuse it by name with no picker to mark.
const INVITE_SUPER_FIELDS = [...INVITE_FIELDS, "tenantId"] as const;

export function InviteUserModal({
  modal,
  isSuperAdmin,
  tenants,
  defaultTenantId,
  onInvited,
}: {
  modal: ModalController;
  isSuperAdmin: boolean;
  // Selectable tenants (SUPER_ADMIN only); empty for a TENANT_ADMIN.
  tenants: { id: string; name: string }[];
  // Pre-selected tenant (the active Users-tab filter), or "" when "All tenants" is selected.
  defaultTenantId: string;
  onInvited: () => void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"AGENT" | "TENANT_ADMIN">("AGENT");
  const [tenantId, setTenantId] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refusal = useFieldRefusal(
    modal.isOpen ? (isSuperAdmin ? INVITE_SUPER_FIELDS : INVITE_FIELDS) : [],
  );

  // A SUPER_ADMIN must target a tenant; block submit until one is chosen.
  const noTarget = isSuperAdmin && !tenantId;

  // What the inputs hold right now, in the server's vocabulary, and what the write sends.
  const current = {
    email,
    role,
    tenantId: isSuperAdmin ? tenantId : undefined,
  };
  const currentRef = useRef(current);
  currentRef.current = current;

  // NOTE: once the invite link is shown the work is saved, so the form is no longer dirty.
  const isDirty =
    !link &&
    (email.trim() !== "" || role !== "AGENT" || tenantId !== defaultTenantId);

  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
    setEmail("");
    setRole("AGENT");
    setTenantId(defaultTenantId);
    setLink(null);
    setCopied(false);
    setError("");
  });

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    const body = { ...current };
    const held = (e: unknown) =>
      refusal.capture(
        e,
        t("invite.failed", "Could not create the invitation"),
        body,
        currentRef.current,
      ) ?? "";
    try {
      const { data, error: apiError } =
        await api.api.admin.invitations.post(body);
      if (apiError) {
        setError(held(apiError));
        return;
      }
      refusal.clear();
      if (data?.invite) {
        setLink(data.invite.acceptUrl);
        onInvited();
      }
    } catch (e) {
      setError(held(e));
    } finally {
      setLoading(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context); the link stays selectable.
    }
  };

  return (
    <Modal
      modal={modal}
      title={t("invite.title", "Invite user")}
      size="md"
      unsavedChanges={isDirty}
    >
      {link ? (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {t(
              "invite.linkHint",
              "Send this one-time link to the invitee. It is shown only once.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-text-primary text-xs">
              {link}
            </code>
            <Button size="sm" variant="secondary" onClick={copyLink}>
              {copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? t("common.copied", "Copied") : t("common.copy", "Copy")}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={modal.close}>{t("common.done", "Done")}</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading && !noTarget) void handleSubmit();
          }}
        >
          {error && (
            <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
              {error}
            </div>
          )}
          {isSuperAdmin && (
            <div>
              <label htmlFor="invite-tenant" className={labelCls}>
                {t("invite.tenant", "Tenant")}
              </label>
              <select
                id="invite-tenant"
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
              {refusal.at("tenantId", current.tenantId) && (
                <p className="mt-1 text-error text-xs">
                  {refusal.at("tenantId", current.tenantId)}
                </p>
              )}
            </div>
          )}
          <div>
            <label htmlFor="invite-email" className={labelCls}>
              {t("invite.email", "Email")}
            </label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              placeholder={t("auth.emailPlaceholder", "you@example.com")}
            />
            {refusal.at("email", current.email) && (
              <p className="mt-1 text-error text-xs">
                {refusal.at("email", current.email)}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="invite-role" className={labelCls}>
              {t("invite.role", "Role")}
            </label>
            <select
              id="invite-role"
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
            {refusal.at("role", current.role) && (
              <p className="mt-1 text-error text-xs">
                {refusal.at("role", current.role)}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={modal.close}
              disabled={loading}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              type="submit"
              loading={loading}
              disabled={loading || noTarget}
            >
              {t("invite.submit", "Create invitation")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
