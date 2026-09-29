import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Skeleton } from "@/client/components";
import { api } from "@/client/lib/api";
import { formatDate } from "@/client/lib/utils";

// Static keys so the skeleton rows don't key off the array index.
const INVITE_SKELETON_KEYS = ["invite-0", "invite-1", "invite-2"];

// Lists invited-but-not-yet-activated users (pending/expired invitations) so they are visible
// before they accept. Consumed invites are hidden (those people now appear in the users table).
// Scopes to the selected tenant filter (tenantId; "" = all, fleet-wide for a SUPER_ADMIN).
type InvitesData = Awaited<
  ReturnType<typeof api.api.admin.invitations.get>
>["data"];
type Invite = NonNullable<InvitesData>["invitations"][number];

export function PendingInvitesCard({
  tenantId,
  reloadToken,
  showTenant,
  tenantNameById,
}: {
  // The active tenant filter ("" = all tenants). Empty sends no tenantId → fleet-wide.
  tenantId: string;
  // Incremented by the parent to force a refetch (e.g. right after a new invite is created).
  reloadToken: number;
  // Show the tenant column (only meaningful in the fleet-wide view).
  showTenant: boolean;
  tenantNameById: Map<string, string>;
}) {
  const { t } = useTranslation();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);

  const fetchInvites = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.api.admin.invitations.get({
        query: tenantId ? { tenantId } : {},
      });
      if (data) {
        // Hide consumed invites — those users are already in the users table.
        setInvites(data.invitations.filter((i) => i.status !== "consumed"));
      }
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  // Fetch on mount, on filter change (fetchInvites depends on tenantId), and whenever the parent
  // bumps reloadToken (post-invite). reloadToken is a trigger-only dependency (not read here).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is an intentional refetch trigger
  useEffect(() => {
    void fetchInvites();
  }, [fetchInvites, reloadToken]);

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    try {
      const { error } = await api.api.admin.invitations({ id }).delete();
      if (!error) setInvites((prev) => prev.filter((i) => i.id !== id));
    } finally {
      setRevoking(null);
    }
  };

  if (!loading && invites.length === 0) return null;

  return (
    <Card>
      <h2 className="mb-4 font-semibold text-lg text-text-primary">
        {t("invite.pendingTitle", "Pending invitations")}
      </h2>
      {loading ? (
        <div className="py-1" role="status">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          {INVITE_SKELETON_KEYS.map((key) => (
            <div
              key={key}
              className="flex items-center gap-4 border-border/50 border-b px-2 py-3"
            >
              <Skeleton className="h-4 w-48" />
              {showTenant && <Skeleton className="h-4 w-28" />}
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="ml-auto h-7 w-24 rounded" />
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b text-left">
                <th className="px-2 py-3 font-medium text-text-secondary">
                  {t("admin.email", "Email")}
                </th>
                {showTenant && (
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("admin.tenant", "Tenant")}
                  </th>
                )}
                <th className="px-2 py-3 font-medium text-text-secondary">
                  {t("admin.role", "Role")}
                </th>
                <th className="px-2 py-3 font-medium text-text-secondary">
                  {t("invite.status", "Status")}
                </th>
                <th className="px-2 py-3 font-medium text-text-secondary">
                  {t("invite.expiresAt", "Expires")}
                </th>
                <th className="px-2 py-3 font-medium text-text-secondary">
                  {t("admin.actions", "Actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr
                  key={invite.id}
                  className="border-border/50 border-b hover:bg-bg-tertiary/50"
                >
                  <td className="px-2 py-3 text-text-primary">
                    {invite.email}
                  </td>
                  {showTenant && (
                    <td className="px-2 py-3 text-text-secondary">
                      {tenantNameById.get(invite.tenantId) ?? invite.tenantId}
                    </td>
                  )}
                  <td className="px-2 py-3 text-text-secondary">
                    {invite.role === "TENANT_ADMIN"
                      ? t("role.tenantAdmin", "Tenant admin")
                      : t("role.agent", "Agent")}
                  </td>
                  <td className="px-2 py-3">
                    <Badge
                      variant={
                        invite.status === "expired" ? "secondary" : "warning"
                      }
                    >
                      {invite.status === "expired"
                        ? t("invite.statusExpired", "Expired")
                        : t("invite.statusPending", "Pending")}
                    </Badge>
                  </td>
                  <td className="px-2 py-3 text-text-secondary">
                    {formatDate(invite.expiresAt)}
                  </td>
                  <td className="px-2 py-3">
                    <Button
                      size="sm"
                      variant="danger"
                      loading={revoking === invite.id}
                      disabled={revoking === invite.id}
                      onClick={() => handleRevoke(invite.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {t("invite.revoke", "Revoke")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
