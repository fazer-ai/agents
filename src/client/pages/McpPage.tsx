import { Check, Copy, Info, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  useModalController,
  useToast,
} from "@/client/components";
import { McpInstall } from "@/client/components/mcp/McpInstall";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { isAdminRole } from "@/client/lib/roles";
import { formatDate } from "@/client/lib/utils";
import { McpAdminSections } from "@/client/pages/mcp/McpAdminSections";

// Single MCP page for every role. Always shows the user's OWN connections (apps they authorized via
// OAuth, with disconnect) plus how to connect this account to an MCP client. A SUPER_ADMIN also sees
// the fleet-wide management sections (McpAdminSections). Replaces the old /admin/mcp.
//
// Rendered as a /settings/mcp sub-route: SettingsLayout already wraps <Outlet/> in <PageContainer>,
// so this page renders sections only (like the other settings sub-pages) and does not wrap again.

// Derived from the treaty responses; never hand-mirrored (see docs/eden-treaty.md).
type ConnsData = Awaited<
  ReturnType<typeof api.api.v1.mcp.me.connections.get>
>["data"];
type MyConnection = NonNullable<ConnsData>["connections"][number];
type InfoData = Awaited<ReturnType<typeof api.api.v1.mcp.me.info.get>>["data"];

// biome-ignore lint/plugin/require-page-container: renders inside SettingsLayout's PageContainer as the /settings/mcp sub-route.
export function McpPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [connections, setConnections] = useState<MyConnection[]>([]);
  const [info, setInfo] = useState<NonNullable<InfoData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const confirm = useModalController<ConfirmPayload>();

  const loadConnections = useCallback(async () => {
    const { data } = await api.api.v1.mcp.me.connections.get();
    setConnections(data?.connections ?? []);
  }, []);

  const fetchInitial = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [connsRes, infoRes] = await Promise.all([
        api.api.v1.mcp.me.connections.get(),
        api.api.v1.mcp.me.info.get(),
      ]);
      if (connsRes.error || infoRes.error) {
        setError(true);
        return;
      }
      setConnections(connsRes.data?.connections ?? []);
      setInfo(infoRes.data ?? null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchInitial();
  }, [fetchInitial]);

  const requestDisconnect = (conn: MyConnection) => {
    confirm.open({
      title: t("mcp.my.disconnectTitle", "Disconnect app"),
      message: t(
        "mcp.my.disconnectMessage",
        "{{client}} stops working immediately and must be authorized again to reconnect.",
        { client: conn.clientName },
      ),
      confirmLabel: t("mcp.my.disconnect", "Disconnect"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.mcp.me
          .connections({ clientId: conn.clientId })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("mcp.my.disconnectFailed", "Could not disconnect the app"),
            "error",
          );
          throw new Error("disconnect failed");
        }
        showToast(t("mcp.my.disconnected", "App disconnected"), "success");
        await loadConnections();
      },
    });
  };

  const copyUrl = async () => {
    if (!info?.url) return;
    try {
      await navigator.clipboard.writeText(info.url);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context); the URL stays selectable.
    }
  };

  // NOTE: standalone t() (not nested in another t()'s options) so i18n:extract keeps the keys.
  const dcrState = info?.dcrEnabled
    ? t("mcp.my.dcrOpen", "open")
    : t("mcp.my.dcrClosed", "closed");

  // Only admins reach Components > MCP (the agent-tools page is an admin-only route) and see
  // "Components" in the nav, so the cross-link note is admin-only — a dead link helps no one else.
  const isAdmin = isAdminRole(user?.role);

  return (
    <div className="space-y-8">
      <header>
        <h2 className="font-semibold text-text-primary">
          {t("mcp.my.title", "MCP")}
        </h2>
        <p className="mt-0.5 text-sm text-text-muted">
          {t(
            "mcp.my.subtitle",
            "Connect MCP apps to your account and manage what is connected.",
          )}
        </p>
      </header>

      {isAdmin && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-bg-secondary p-4">
          <Info
            className="mt-0.5 h-5 w-5 shrink-0 text-accent"
            aria-hidden="true"
          />
          <div className="flex-1 space-y-1.5">
            <p className="font-medium text-sm text-text-primary">
              {t(
                "mcp.my.agentToolsNote",
                "Looking to give your agent MCP tools?",
              )}
            </p>
            <p className="text-sm text-text-secondary">
              {t(
                "mcp.my.agentToolsHint",
                "This page is for connecting external apps to your own account. To let an agent use external MCP servers as tools, go to",
              )}{" "}
              <Link
                to="/resources/mcp"
                className="font-medium text-accent hover:underline"
              >
                {t("mcp.my.agentToolsLink", "Components > MCP")}
              </Link>
            </p>
          </div>
        </div>
      )}

      <DataBoundary
        loading={loading}
        error={error}
        onRetry={() => void fetchInitial()}
      >
        {info && (
          <section className="space-y-5">
            <h2 className="font-semibold text-lg text-text-primary">
              {t("mcp.my.connectTitle", "How to connect")}
            </h2>

            <McpInstall url={info.url} />

            <div className="space-y-1.5">
              <span className="font-medium text-sm text-text-secondary">
                {t("mcp.my.endpoint", "MCP endpoint")}
              </span>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-text-primary text-xs">
                  {info.url}
                </code>
                <Button size="sm" variant="secondary" onClick={copyUrl}>
                  {copied ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  )}
                  {copied
                    ? t("common.copied", "Copied")
                    : t("common.copy", "Copy")}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="font-medium text-sm text-text-secondary">
                {t("mcp.my.scopes", "Available scopes")}
              </span>
              <div className="flex flex-wrap gap-1">
                {info.scopes.map((s) => (
                  <Badge key={s} variant="secondary">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-4">
              <span className="font-medium text-sm text-text-primary">
                {t("mcp.my.authOAuth", "OAuth 2.1 (recommended)")}
              </span>
              <p className="text-sm text-text-secondary">
                {t(
                  "mcp.my.authOAuthHint",
                  "Point your MCP client at the endpoint and it discovers the login automatically. Self-registration (DCR) is {{state}}.",
                  { state: dcrState },
                )}
              </p>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-4">
              <span className="font-medium text-sm text-text-primary">
                {t("mcp.my.authApiKey", "API key (alternative)")}
              </span>
              <p className="text-sm text-text-secondary">
                {t(
                  "mcp.my.authApiKeyHint",
                  "Or send a per-tenant API key as a bearer token instead of OAuth. Create one under API keys.",
                )}
              </p>
              <code className="block w-fit rounded bg-bg-tertiary px-2 py-1 font-mono text-text-secondary text-xs">
                {"Authorization: Bearer fazerai_…"}
              </code>
            </div>
          </section>
        )}

        <section className="space-y-4">
          <div>
            <h2 className="font-semibold text-lg text-text-primary">
              {t("mcp.my.connectionsTitle", "Your connections")}
            </h2>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "mcp.my.connectionsSubtitle",
                "Apps you have authorized to access your account.",
              )}
            </p>
          </div>
          {connections.length === 0 ? (
            <EmptyState
              title={t("mcp.my.noConnectionsTitle", "No connected apps")}
              description={t(
                "mcp.my.noConnectionsDescription",
                "When you authorize an MCP app (Claude, Cursor), it shows up here and you can disconnect it.",
              )}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {connections.map((conn) => (
                <Card
                  key={conn.clientId}
                  className="flex flex-wrap items-start justify-between gap-4"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-text-primary">
                        {conn.clientName}
                      </span>
                      {conn.unverified && (
                        <Badge variant="warning">
                          {t("mcp.my.unverifiedBadge", "Unverified")}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {conn.scopes.map((s) => (
                        <Badge key={s} variant="secondary">
                          {s}
                        </Badge>
                      ))}
                    </div>
                    <span className="mt-1 text-text-muted text-xs">
                      {t("mcp.my.connectedAt", "Connected {{date}}", {
                        date: formatDate(conn.connectedAt),
                      })}
                    </span>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => requestDisconnect(conn)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    {t("mcp.my.disconnect", "Disconnect")}
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </section>
      </DataBoundary>

      <ConfirmDialog modal={confirm} />

      {user?.role === "SUPER_ADMIN" ? <McpAdminSections /> : null}
    </div>
  );
}
