import { Search, Shield, ShieldOff, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  Skeleton,
  StrongConfirmModal,
  type StrongConfirmPayload,
  useModalController,
  useToast,
} from "@/client/components";
import { InviteUserModal } from "@/client/components/admin/InviteUserModal";
import { PendingInvitesCard } from "@/client/components/admin/PendingInvitesCard";
import { Tooltip } from "@/client/components/Tooltip";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { isAdminRole } from "@/client/lib/roles";
import { cn, formatDate } from "@/client/lib/utils";

type UsersResponse = Awaited<
  ReturnType<typeof api.api.admin.users.get>
>["data"];
type StatsResponse = Awaited<
  ReturnType<typeof api.api.admin.stats.get>
>["data"];

type AdminUser = NonNullable<UsersResponse>["users"][number];
type AdminStats = NonNullable<StatsResponse>["stats"];

// t('admin.noUsers', 'No users found')
// t('admin.demoteTooltip', 'Demote to User')
// t('admin.promoteTooltip', 'Promote to Admin')
const SEARCH_DEBOUNCE_MS = 300;
const selectCls =
  "rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none";
// NOTE: Static keys so the skeleton rows don't key off the array index.
const USER_SKELETON_KEYS = [
  "user-0",
  "user-1",
  "user-2",
  "user-3",
  "user-4",
  "user-5",
  "user-6",
  "user-7",
];

export function AdminUsersPage() {
  const { t } = useTranslation();
  const roleLabel = (role: string) => {
    switch (role) {
      case "SUPER_ADMIN":
        return t("role.superAdmin", "Super admin");
      case "TENANT_ADMIN":
        return t("role.tenantAdmin", "Tenant admin");
      default:
        return t("role.agent", "Agent");
    }
  };
  const { showToast } = useToast();
  const { user: currentUser } = useAuth();
  const isSuperAdmin = currentUser?.role === "SUPER_ADMIN";

  const [searchParams, setSearchParams] = useSearchParams();
  // The tenant filter ("" = all tenants). Only a SUPER_ADMIN can filter; everyone else is
  // backend-fenced to their own tenant regardless of the param.
  const selectedTenantId = isSuperAdmin
    ? (searchParams.get("tenant") ?? "")
    : "";
  // Tenant column is only meaningful in the fleet-wide view (rows span tenants).
  const showTenantColumn = isSuperAdmin && !selectedTenantId;

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [invitesReloadToken, setInvitesReloadToken] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inviteModal = useModalController();
  const deleteUserModal = useModalController<StrongConfirmPayload>();

  const tenantsById = useMemo(
    () => new Map(tenants.map((tn) => [tn.id, tn.name])),
    [tenants],
  );

  const fetchTenants = useCallback(async () => {
    if (!isSuperAdmin) return;
    const { data } = await api.api.admin.tenants.get();
    if (data) {
      setTenants(data.tenants.map((tn) => ({ id: tn.id, name: tn.name })));
    }
  }, [isSuperAdmin]);

  const fetchStats = useCallback(async () => {
    const { data } = await api.api.admin.stats.get({
      query: selectedTenantId ? { tenantId: selectedTenantId } : {},
    });
    if (data?.stats) setStats(data.stats);
  }, [selectedTenantId]);

  const fetchUsers = useCallback(
    async (pageNum = 1, searchQuery = "") => {
      setLoading(true);
      try {
        const { data } = await api.api.admin.users.get({
          query: {
            page: String(pageNum),
            search: searchQuery || undefined,
            tenantId: selectedTenantId || undefined,
          },
        });
        if (data) {
          setUsers(data.users);
          setTotalPages(data.totalPages);
          setPage(data.page);
        }
      } finally {
        setLoading(false);
      }
    },
    [selectedTenantId],
  );

  useEffect(() => {
    void fetchTenants();
  }, [fetchTenants]);

  // (Re)load on mount and whenever the tenant filter changes (fetchUsers/fetchStats identity
  // changes with selectedTenantId). Reset the search box on a tenant switch.
  useEffect(() => {
    setSearch("");
    void fetchUsers(1, "");
    void fetchStats();
  }, [fetchUsers, fetchStats]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleFilterChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("tenant", value);
    else next.delete("tenant");
    setSearchParams(next, { replace: true });
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchUsers(1, value);
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleSearchSubmit = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    fetchUsers(1, search);
  };

  const handleToggleRole = async (user: AdminUser) => {
    const newRole = isAdminRole(user.role) ? "AGENT" : "TENANT_ADMIN";
    const { data, error } = await api.api.admin
      .users({ id: user.id })
      .role.patch({
        role: newRole,
      });

    if (error) {
      showToast(
        apiErrorMessage(error) ||
          t("admin.roleUpdateFailed", "Failed to update role"),
        "error",
      );
      return;
    }

    if (data?.user) {
      setUsers((prev) =>
        prev.map((u) =>
          u.id === user.id ? { ...u, role: data.user.role } : u,
        ),
      );
      showToast(
        t("admin.roleUpdated", "Role updated to {{role}}", {
          role: newRole,
        }),
        "success",
      );
      fetchStats();
    }
  };

  // Irreversible: deletes the user (step-up password). The server refuses self-delete / last-admin
  // and returns a localized message, surfaced in the toast.
  function openDeleteUser(user: AdminUser) {
    deleteUserModal.open({
      title: t("admin.deleteUser", "Delete user"),
      warning: t(
        "admin.deleteUserWarning",
        "This permanently deletes {{email}} and revokes their access. It cannot be undone.",
        { email: user.email },
      ),
      confirmPhrase: user.email,
      confirmLabel: t("admin.deleteUserConfirm", "Type {{email}} to confirm", {
        email: user.email,
      }),
      actionLabel: t("admin.deleteUser", "Delete user"),
      onConfirm: async (password) => {
        const { error } = await api.api.admin
          .users({ id: user.id })
          .delete({ password });
        if (error) {
          showToast(
            apiErrorMessage(error) ||
              t("admin.deleteUserError", "Could not delete the user."),
            "error",
          );
          throw error;
        }
        showToast(t("admin.deleteUserDone", "User deleted."), "success");
        setUsers((prev) => prev.filter((u) => u.id !== user.id));
        fetchStats();
      },
    });
  }

  return (
    <div className="space-y-6 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {isSuperAdmin ? (
          <div>
            <label htmlFor="tenant-filter" className="sr-only">
              {t("admin.filterByTenant", "Filter by tenant")}
            </label>
            <select
              id="tenant-filter"
              className={selectCls}
              value={selectedTenantId}
              onChange={(e) => handleFilterChange(e.target.value)}
            >
              <option value="">{t("admin.allTenants", "All tenants")}</option>
              {tenants.map((tn) => (
                <option key={tn.id} value={tn.id}>
                  {tn.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <span />
        )}
        <Button size="sm" onClick={() => inviteModal.open()}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          {t("admin.inviteUser", "Invite user")}
        </Button>
      </div>

      <InviteUserModal
        modal={inviteModal}
        isSuperAdmin={isSuperAdmin}
        tenants={tenants}
        defaultTenantId={selectedTenantId}
        onInvited={() => {
          setInvitesReloadToken((n) => n + 1);
        }}
      />

      <StrongConfirmModal modal={deleteUserModal} />

      {stats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card className="flex items-center gap-4">
            <div className="rounded-lg bg-bg-tertiary p-3">
              <Shield className="h-6 w-6 text-accent" aria-hidden="true" />
            </div>
            <div>
              <p className="font-bold text-2xl text-text-primary">
                {stats.totalUsers}
              </p>
              <p className="text-sm text-text-secondary">
                {t("admin.totalUsers", "Total Users")}
              </p>
            </div>
          </Card>
          <Card className="flex items-center gap-4">
            <div className="rounded-lg bg-bg-tertiary p-3">
              <Shield className="h-6 w-6 text-purple" aria-hidden="true" />
            </div>
            <div>
              <p className="font-bold text-2xl text-text-primary">
                {stats.adminCount}
              </p>
              <p className="text-sm text-text-secondary">
                {t("admin.admins", "Admins")}
              </p>
            </div>
          </Card>
        </div>
      )}

      <PendingInvitesCard
        tenantId={selectedTenantId}
        reloadToken={invitesReloadToken}
        showTenant={showTenantColumn}
        tenantNameById={tenantsById}
      />

      <Card>
        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearchSubmit()}
              placeholder={t("admin.searchUsers", "Search users by email...")}
              aria-label={t("admin.searchUsers", "Search users by email...")}
              className="w-full rounded-lg border border-border bg-bg-tertiary py-2 pr-4 pl-10 text-text-primary placeholder-text-placeholder focus:border-border-focus focus:outline-none"
            />
          </div>
          <Button size="sm" onClick={handleSearchSubmit} disabled={loading}>
            {t("common.search", "Search")}
          </Button>
        </div>

        {loading ? (
          <div className="py-2" role="status">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            {USER_SKELETON_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center gap-4 border-border/50 border-b px-2 py-3"
              >
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-32" />
                {showTenantColumn && <Skeleton className="h-4 w-28" />}
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="ml-auto h-7 w-24 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-border border-b text-left">
                    <th className="px-2 py-3 font-medium text-text-secondary">
                      {t("admin.email", "Email")}
                    </th>
                    <th className="px-2 py-3 font-medium text-text-secondary">
                      {t("admin.name", "Name")}
                    </th>
                    {showTenantColumn && (
                      <th className="px-2 py-3 font-medium text-text-secondary">
                        {t("admin.tenant", "Tenant")}
                      </th>
                    )}
                    <th className="px-2 py-3 font-medium text-text-secondary">
                      {t("admin.role", "Role")}
                    </th>
                    <th className="px-2 py-3 font-medium text-text-secondary">
                      {t("admin.createdAt", "Created")}
                    </th>
                    <th className="px-2 py-3 font-medium text-text-secondary">
                      {t("admin.lastLogin", "Last Login")}
                    </th>
                    <th className="px-2 py-3 font-medium text-text-secondary">
                      {t("admin.actions", "Actions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr>
                      <td
                        colSpan={showTenantColumn ? 7 : 6}
                        className="px-2 py-10 text-center text-sm text-text-muted"
                      >
                        {t("admin.noUsers", "No users found")}
                      </td>
                    </tr>
                  ) : (
                    users.map((user) => {
                      const isSelf = user.id === currentUser?.id;
                      const disabled = isSelf && isAdminRole(user.role);
                      const isAdmin = isAdminRole(user.role);
                      const tooltip = disabled
                        ? t("admin.cannotDemoteSelf", "Cannot demote yourself")
                        : isAdmin
                          ? t("admin.demoteTooltip", "Demote to User")
                          : t("admin.promoteTooltip", "Promote to Admin");
                      return (
                        <tr
                          key={user.id}
                          className="border-border/50 border-b hover:bg-bg-tertiary/50"
                        >
                          <td className="px-2 py-3 text-text-primary">
                            {user.email}
                          </td>
                          <td className="px-2 py-3 text-text-secondary">
                            {user.name || "-"}
                          </td>
                          {showTenantColumn && (
                            <td className="px-2 py-3 text-text-secondary">
                              {user.tenantId
                                ? (tenantsById.get(user.tenantId) ??
                                  user.tenantId)
                                : "—"}
                            </td>
                          )}
                          <td className="px-2 py-3">
                            <Badge variant={isAdmin ? "warning" : "secondary"}>
                              {roleLabel(user.role)}
                            </Badge>
                          </td>
                          <td className="px-2 py-3 text-text-secondary">
                            {formatDate(user.createdAt)}
                          </td>
                          <td className="px-2 py-3 text-text-secondary">
                            {formatDate(user.lastLoginAt)}
                          </td>
                          <td className="px-2 py-3">
                            <div className="flex items-center gap-1">
                              <Tooltip content={tooltip} side="top">
                                <button
                                  type="button"
                                  onClick={() => handleToggleRole(user)}
                                  disabled={disabled}
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-medium text-xs transition-colors",
                                    {
                                      "bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary":
                                        !disabled,
                                      "cursor-not-allowed bg-bg-tertiary text-text-muted opacity-50":
                                        disabled,
                                    },
                                  )}
                                  aria-label={tooltip}
                                >
                                  {isAdmin ? (
                                    <>
                                      <ShieldOff
                                        className="h-3 w-3"
                                        aria-hidden="true"
                                      />
                                      {t("admin.demote", "Demote")}
                                    </>
                                  ) : (
                                    <>
                                      <Shield
                                        className="h-3 w-3"
                                        aria-hidden="true"
                                      />
                                      {t("admin.promote", "Promote")}
                                    </>
                                  )}
                                </button>
                              </Tooltip>
                              <Tooltip
                                content={
                                  isSelf
                                    ? t(
                                        "admin.cannotDeleteSelf",
                                        "You cannot delete yourself",
                                      )
                                    : t("admin.deleteUser", "Delete user")
                                }
                                side="top"
                              >
                                <button
                                  type="button"
                                  onClick={() => openDeleteUser(user)}
                                  disabled={isSelf}
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-medium text-xs transition-colors",
                                    {
                                      "bg-bg-tertiary text-text-secondary hover:bg-error/10 hover:text-error":
                                        !isSelf,
                                      "cursor-not-allowed bg-bg-tertiary text-text-muted opacity-50":
                                        isSelf,
                                    },
                                  )}
                                  aria-label={t(
                                    "admin.deleteUser",
                                    "Delete user",
                                  )}
                                >
                                  <Trash2
                                    className="h-3 w-3"
                                    aria-hidden="true"
                                  />
                                  {t("common.delete", "Delete")}
                                </button>
                              </Tooltip>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => fetchUsers(page - 1, search)}
                >
                  {t("common.previous", "Previous")}
                </Button>
                <span className="flex items-center px-3 text-sm text-text-secondary">
                  {t("common.pageOf", "{{page}} of {{total}}", {
                    page,
                    total: totalPages,
                  })}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => fetchUsers(page + 1, search)}
                >
                  {t("common.next", "Next")}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
