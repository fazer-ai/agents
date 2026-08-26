import { Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  Dropdown,
  EmptyState,
  Tabs,
  useModalController,
  useToast,
} from "@/client/components";
import {
  type McpClientPayload,
  RegisterMcpClientModal,
} from "@/client/components/mcp/RegisterMcpClientModal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDate } from "@/client/lib/utils";

// Admin management of OUR MCP server (third transport): OAuth clients, active tokens and
// remembered approvals across every tenant. SUPER_ADMIN-only — rendered as a section of the shared
// /mcp page (McpPage) below the user's own connections. Connection/how-to-connect info is NOT here:
// it lives in the shared McpPage section (from /v1/mcp/me/info), visible to every role.

// Derived from the treaty responses; never hand-mirrored (see docs/eden-treaty.md).
type ClientsData = Awaited<
  ReturnType<typeof api.api.v1.mcp.admin.clients.get>
>["data"];
type McpClient = NonNullable<ClientsData>["clients"][number];
type TokensData = Awaited<
  ReturnType<typeof api.api.v1.mcp.admin.tokens.get>
>["data"];
type McpToken = NonNullable<TokensData>["tokens"][number];
type ApprovalsData = Awaited<
  ReturnType<typeof api.api.v1.mcp.admin.approvals.get>
>["data"];
type McpApproval = NonNullable<ApprovalsData>["approvals"][number];
type TenantsData = Awaited<ReturnType<typeof api.api.v1.tenants.get>>["data"];
type Tenant = NonNullable<TenantsData>["tenants"][number];

export function McpAdminSections() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [tab, setTab] = useState<"clients" | "tokens" | "approvals">("clients");
  const [clients, setClients] = useState<McpClient[]>([]);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [approvals, setApprovals] = useState<McpApproval[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tokenFilter, setTokenFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tokensLoading, setTokensLoading] = useState(false);
  const clientModal = useModalController<McpClientPayload>();
  const confirm = useModalController<ConfirmPayload>();

  const loadTokens = useCallback(async (tenantId: string) => {
    setTokensLoading(true);
    try {
      const { data } = await api.api.v1.mcp.admin.tokens.get({
        query: tenantId ? { tenantId } : {},
      });
      setTokens(data?.tokens ?? []);
    } catch {
      setTokens([]);
    } finally {
      setTokensLoading(false);
    }
  }, []);

  const loadClients = useCallback(async () => {
    const { data } = await api.api.v1.mcp.admin.clients.get();
    setClients(data?.clients ?? []);
  }, []);

  const loadApprovals = useCallback(async () => {
    const { data } = await api.api.v1.mcp.admin.approvals.get();
    setApprovals(data?.approvals ?? []);
  }, []);

  const fetchInitial = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [clientsRes, tenantsRes, approvalsRes] = await Promise.all([
        api.api.v1.mcp.admin.clients.get(),
        api.api.v1.tenants.get(),
        api.api.v1.mcp.admin.approvals.get(),
      ]);
      if (clientsRes.error) {
        setError(true);
        return;
      }
      setClients(clientsRes.data?.clients ?? []);
      setTenants(tenantsRes.data?.tenants ?? []);
      setApprovals(approvalsRes.data?.approvals ?? []);
      await loadTokens("");
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [loadTokens]);

  useEffect(() => {
    void fetchInitial();
  }, [fetchInitial]);

  const requestDeleteClient = (client: McpClient) => {
    confirm.open({
      title: t("mcp.admin.deleteClientTitle", "Delete MCP client"),
      message: t(
        "mcp.admin.deleteClientMessage",
        "All of this client's tokens are revoked immediately. This cannot be undone.",
      ),
      confirmLabel: t("common.delete", "Delete"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.mcp.admin
          .clients({ clientId: client.clientId })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("mcp.admin.clientDeleteFailed", "Could not delete the client"),
            "error",
          );
          throw new Error("delete failed");
        }
        showToast(t("mcp.admin.clientDeleted", "Client deleted"), "success");
        await loadClients();
        await loadTokens(tokenFilter);
      },
    });
  };

  const requestRevokeToken = (token: McpToken) => {
    confirm.open({
      title: t("mcp.admin.revokeTokenTitle", "Revoke token"),
      message: t(
        "mcp.admin.revokeTokenMessage",
        "The client stops working immediately and cannot refresh a new token.",
      ),
      confirmLabel: t("mcp.admin.revoke", "Revoke"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.mcp.admin
          .tokens({ jti: token.jti })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("mcp.admin.revokeFailed", "Could not revoke the token"),
            "error",
          );
          throw new Error("revoke failed");
        }
        showToast(t("mcp.admin.tokenRevoked", "Token revoked"), "success");
        await loadTokens(tokenFilter);
      },
    });
  };

  const requestRevokeApproval = (approval: McpApproval) => {
    confirm.open({
      title: t("mcp.admin.revokeApprovalTitle", "Revoke approval"),
      message: t(
        "mcp.admin.revokeApprovalMessage",
        "The next time this user connects this client, they will be asked to approve again.",
      ),
      confirmLabel: t("mcp.admin.revoke", "Revoke"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.mcp.admin
          .approvals({ id: approval.id })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t(
                "mcp.admin.revokeApprovalFailed",
                "Could not revoke the approval",
              ),
            "error",
          );
          throw new Error("revoke failed");
        }
        showToast(
          t("mcp.admin.approvalRevoked", "Approval revoked"),
          "success",
        );
        await loadApprovals();
      },
    });
  };

  const tenantName = (id: string | null) =>
    id ? (tenants.find((tn) => tn.id === id)?.name ?? `#${id}`) : null;

  const TABS = [
    { key: "clients", label: t("mcp.admin.tabClients", "Clients") },
    { key: "tokens", label: t("mcp.admin.tabTokens", "Active tokens") },
    { key: "approvals", label: t("mcp.admin.tabApprovals", "Approvals") },
  ];

  return (
    <section className="space-y-6 border-border border-t pt-8">
      <header className="flex items-center gap-3">
        <Server className="h-6 w-6 text-accent" aria-hidden="true" />
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-lg text-text-primary">
              {t("mcp.admin.title", "MCP server")}
            </h2>
            <Badge variant="secondary">
              {t("mcp.admin.adminOnly", "Admin only")}
            </Badge>
          </div>
          <p className="mt-0.5 text-sm text-text-muted">
            {t(
              "mcp.admin.subtitle",
              "Manage OAuth clients and active sessions across the fleet.",
            )}
          </p>
        </div>
      </header>

      <Tabs
        items={TABS}
        value={tab}
        onChange={(k) => setTab(k as typeof tab)}
        aria-label={t("mcp.admin.sections", "MCP sections")}
      />

      <RegisterMcpClientModal
        modal={clientModal}
        onSaved={() => {
          showToast(t("mcp.admin.clientSaved", "Client saved"), "success");
          void loadClients();
        }}
      />
      <ConfirmDialog modal={confirm} />

      <DataBoundary
        loading={loading}
        error={error}
        onRetry={() => void fetchInitial()}
      >
        {tab === "clients" && (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button onClick={() => clientModal.open({})}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("mcp.admin.registerClient", "Register client")}
              </Button>
            </div>
            {clients.length === 0 ? (
              <EmptyState
                title={t("mcp.admin.noClientsTitle", "No MCP clients yet")}
                description={t(
                  "mcp.admin.noClientsDescription",
                  "Register a client so an MCP app (Claude, Cursor) can connect via OAuth.",
                )}
              />
            ) : (
              <div className="flex flex-col gap-3">
                {clients.map((client) => (
                  <Card
                    key={client.clientId}
                    className="flex flex-wrap items-start justify-between gap-4"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-text-primary">
                          {client.name}
                        </span>
                        {client.firstParty && (
                          <Badge variant="info">
                            {t("mcp.admin.trustedBadge", "Trusted")}
                          </Badge>
                        )}
                        {client.dynamicallyRegistered && !client.firstParty && (
                          <Badge variant="warning">
                            {t("mcp.admin.unverifiedBadge", "Unverified")}
                          </Badge>
                        )}
                      </div>
                      <code className="w-fit rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-text-secondary text-xs">
                        {client.clientId}
                      </code>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {client.scopes.map((s) => (
                          <Badge key={s} variant="secondary">
                            {s}
                          </Badge>
                        ))}
                      </div>
                      <span className="mt-1 break-all text-text-muted text-xs">
                        {client.redirectUris.join(", ")}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          clientModal.open({
                            clientId: client.clientId,
                            name: client.name,
                            redirectUris: client.redirectUris,
                            scopes: client.scopes,
                            firstParty: client.firstParty,
                          })
                        }
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                        {t("common.edit", "Edit")}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => requestDeleteClient(client)}
                        aria-label={t(
                          "mcp.admin.deleteClient",
                          "Delete client",
                        )}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "tokens" && (
          <div className="space-y-4">
            <div className="max-w-xs">
              <Dropdown
                value={tokenFilter || null}
                onChange={(v) => {
                  setTokenFilter(v);
                  void loadTokens(v);
                }}
                ariaLabel={t("mcp.admin.filterTenant", "Filter by tenant")}
                placeholder={t("mcp.admin.allTenants", "All tenants")}
                items={[
                  {
                    value: "",
                    label: t("mcp.admin.allTenants", "All tenants"),
                  },
                  ...tenants.map((tn) => ({ value: tn.id, label: tn.name })),
                ]}
              />
            </div>
            <DataBoundary
              loading={tokensLoading}
              error={false}
              isEmpty={tokens.length === 0}
              empty={
                <EmptyState
                  title={t("mcp.admin.noTokensTitle", "No active tokens")}
                  description={t(
                    "mcp.admin.noTokensDescription",
                    "There are no valid MCP access tokens right now.",
                  )}
                />
              }
            >
              <div className="flex flex-col gap-3">
                {tokens.map((token) => (
                  <Card
                    key={token.jti}
                    className="flex flex-wrap items-center justify-between gap-4"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="font-medium text-sm text-text-primary">
                        {token.clientName ?? token.clientId}
                      </span>
                      <span className="text-text-secondary text-xs">
                        {token.userEmail ?? `user #${token.userId}`}
                        {tenantName(token.tenantId)
                          ? ` · ${tenantName(token.tenantId)}`
                          : ""}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {token.scopes.map((s) => (
                          <Badge key={s} variant="secondary">
                            {s}
                          </Badge>
                        ))}
                      </div>
                      <span className="text-text-muted text-xs">
                        {t("mcp.admin.expiresAt", "Expires {{date}}", {
                          date: formatDate(token.expiresAt),
                        })}
                      </span>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => requestRevokeToken(token)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      {t("mcp.admin.revoke", "Revoke")}
                    </Button>
                  </Card>
                ))}
              </div>
            </DataBoundary>
          </div>
        )}

        {tab === "approvals" && (
          <div className="space-y-4">
            {approvals.length === 0 ? (
              <EmptyState
                title={t("mcp.admin.noApprovalsTitle", "No approvals yet")}
                description={t(
                  "mcp.admin.noApprovalsDescription",
                  "When a user approves a client on the consent screen, it appears here and can be revoked.",
                )}
              />
            ) : (
              <div className="flex flex-col gap-3">
                {approvals.map((approval) => (
                  <Card
                    key={approval.id}
                    className="flex flex-wrap items-center justify-between gap-4"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="font-medium text-sm text-text-primary">
                        {approval.clientName ?? approval.clientId}
                      </span>
                      <span className="text-text-secondary text-xs">
                        {approval.userEmail ?? `user #${approval.userId}`}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {approval.scopes.map((s) => (
                          <Badge key={s} variant="secondary">
                            {s}
                          </Badge>
                        ))}
                      </div>
                      <span className="text-text-muted text-xs">
                        {t("mcp.admin.approvedAt", "Approved {{date}}", {
                          date: formatDate(approval.createdAt),
                        })}
                      </span>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => requestRevokeApproval(approval)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      {t("mcp.admin.revoke", "Revoke")}
                    </Button>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </DataBoundary>
    </section>
  );
}
