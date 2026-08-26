import { Check, Copy, Loader2, LogIn, LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { FormField } from "@/client/components/FormField";
import { Input } from "@/client/components/Input";
import { useModalController } from "@/client/components/Modal";
import { useToast } from "@/client/components/Toast";
import { Tooltip } from "@/client/components/Tooltip";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { watchOAuthPopup } from "@/client/lib/oauthPopup";

// Derived from the treaty response; never hand-mirrored (see docs/eden-treaty.md).
type OAuthStatus = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<typeof api.api.v1.vault>["oauth"]["mcp"]["status"]["get"]
    >
  >["data"]
>;

interface McpOAuthSectionProps {
  entryId: string;
}

// MCP OAuth connection section shown inside CredentialForm when kind === "mcp_oauth" and the entry
// is already saved (has a stable id). Manages the authorize → popup → status cycle. Unlike the Google
// section there is no scope picker: the scopes come from the server's discovery document, and the
// client is registered automatically via DCR.
//
// t('vault.mcpOAuth.sectionTitle', 'MCP connection')
// t('vault.mcpOAuth.redirectUri', 'Redirect URI')
// t('vault.mcpOAuth.redirectUriHint', 'Registered automatically with the MCP server via dynamic client registration.')
// t('vault.mcpOAuth.connected', 'Connected')
// t('vault.mcpOAuth.notConnected', 'Not connected')
// t('vault.mcpOAuth.issuerLabel', 'Authorization server')
// t('vault.mcpOAuth.resourceLabel', 'Resource')
// t('vault.mcpOAuth.grantedScopes', 'Granted scopes')
// t('vault.mcpOAuth.connect', 'Connect')
// t('vault.mcpOAuth.disconnect', 'Disconnect')
// t('vault.mcpOAuth.disconnectTitle', 'Disconnect MCP server')
// t('vault.mcpOAuth.disconnectMessage', 'This will drop the stored tokens and disconnect this MCP server.')
// t('vault.mcpOAuth.connected_toast', 'MCP server connected.')
// t('vault.mcpOAuth.disconnected_toast', 'MCP server disconnected.')
// t('vault.mcpOAuth.connectError', 'Could not start the authorization flow.')
// t('vault.mcpOAuth.popupBlocked', 'The popup was blocked. Allow popups for this site and try again.')
// t('vault.mcpOAuth.authFailed', 'Authorization failed: {{message}}')
// t('vault.mcpOAuth.signedInHint', 'You must be signed in to the MCP server in your browser to approve access.')
export function McpOAuthSection({ entryId }: McpOAuthSectionProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disconnectModal = useModalController<{
    title: string;
    message?: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
  }>();

  // Cancels the in-flight popup watcher on unmount (avoids setState after the modal closes).
  const watcherCancelRef = useRef<(() => void) | null>(null);

  const redirectUri = `${window.location.origin}/api/v1/oauth/mcp/callback`;

  // Re-reads the server (the source of truth: the callback persists tokens server-side) and reflects
  // it, returning whether the credential is now connected. No skeleton flash — used post-popup.
  const refreshStatus = useCallback(async (): Promise<boolean> => {
    try {
      const { data } = await api.api.v1
        .vault({ id: entryId })
        .oauth.mcp.status.get();
      if (data) setStatus(data as OAuthStatus);
      return !!(data as OAuthStatus | null)?.connected;
    } catch {
      return false;
    }
  }, [entryId]);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      await refreshStatus();
    } finally {
      setStatusLoading(false);
    }
  }, [refreshStatus]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => () => watcherCancelRef.current?.(), []);

  async function handleConnect() {
    if (connecting) return;
    setConnecting(true);

    let url: string;
    try {
      const { data, error: err } = await api.api.v1
        .vault({ id: entryId })
        .oauth.mcp.authorize.post();
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ||
            t(
              "vault.mcpOAuth.connectError",
              "Could not start the authorization flow.",
            ),
          "error",
        );
        setConnecting(false);
        return;
      }
      url = (data as { url: string }).url;
    } catch {
      showToast(
        t(
          "vault.mcpOAuth.connectError",
          "Could not start the authorization flow.",
        ),
        "error",
      );
      setConnecting(false);
      return;
    }

    const popup = window.open(url, "mcp-oauth", "width=520,height=720");
    if (!popup) {
      showToast(
        t(
          "vault.mcpOAuth.popupBlocked",
          "The popup was blocked. Allow popups for this site and try again.",
        ),
        "error",
      );
      setConnecting(false);
      return;
    }

    const { result, cancel } = watchOAuthPopup({
      channel: "oauth-mcp",
      messageType: "mcp-oauth",
      pollStatus: refreshStatus,
    });
    watcherCancelRef.current = cancel;
    const outcome = await result;
    watcherCancelRef.current = null;
    setConnecting(false);

    if (outcome.type === "error") {
      showToast(
        t("vault.mcpOAuth.authFailed", "Authorization failed: {{message}}", {
          message: outcome.message ?? "unknown",
        }),
        "error",
      );
      return;
    }

    // success | timeout → reflect the server's truth. On timeout this catches a late success the
    // poll/message both missed; a timeout with no connection means the operator abandoned consent →
    // stay silent.
    const connected = await refreshStatus();
    if (connected) {
      showToast(
        t("vault.mcpOAuth.connected_toast", "MCP server connected."),
        "success",
      );
    }
  }

  async function handleDisconnect() {
    const { error: err } = await api.api.v1
      .vault({ id: entryId })
      .oauth.mcp.disconnect.post();
    if (err) throw err;
    showToast(
      t("vault.mcpOAuth.disconnected_toast", "MCP server disconnected."),
      "success",
    );
    await fetchStatus();
  }

  function askDisconnect() {
    disconnectModal.open({
      title: t("vault.mcpOAuth.disconnectTitle", "Disconnect MCP server"),
      message: t(
        "vault.mcpOAuth.disconnectMessage",
        "This will drop the stored tokens and disconnect this MCP server.",
      ),
      danger: true,
      onConfirm: handleDisconnect,
    });
  }

  function copyRedirectUri() {
    navigator.clipboard.writeText(redirectUri).catch(() => undefined);
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const isConnected = !!status?.connected;
  const scopes = status?.scopes ?? [];

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-tertiary p-4">
      <p className="font-medium text-sm text-text-primary">
        {t("vault.mcpOAuth.sectionTitle", "MCP connection")}
      </p>

      {/* Redirect URI — always visible (registered automatically via DCR) */}
      <FormField
        label={t("vault.mcpOAuth.redirectUri", "Redirect URI")}
        group
        description={t(
          "vault.mcpOAuth.redirectUriHint",
          "Registered automatically with the MCP server via dynamic client registration.",
        )}
      >
        <div className="flex items-center gap-2">
          <Input
            value={redirectUri}
            readOnly
            className="font-mono text-xs"
            aria-label={t("vault.mcpOAuth.redirectUri", "Redirect URI")}
          />
          <Tooltip
            content={
              copied ? t("common.copied", "Copied") : t("common.copy", "Copy")
            }
          >
            <button
              type="button"
              onClick={copyRedirectUri}
              aria-label={t("common.copy", "Copy")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-secondary text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              {copied ? (
                <Check className="h-4 w-4 text-success" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        </div>
      </FormField>

      {statusLoading ? (
        <div
          className="flex items-center gap-2 text-sm text-text-muted"
          role="status"
        >
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          {t("common.loading", "Loading…")}
        </div>
      ) : isConnected ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Check
              className="h-4 w-4 shrink-0 text-success"
              aria-hidden="true"
            />
            <span className="text-sm text-text-primary">
              {t("vault.mcpOAuth.connected", "Connected")}
            </span>
          </div>

          {status?.issuer && (
            <div>
              <p className="mb-1.5 text-text-muted text-xs">
                {t("vault.mcpOAuth.issuerLabel", "Authorization server")}
              </p>
              <p className="break-all font-mono text-text-secondary text-xs">
                {status.issuer}
              </p>
            </div>
          )}

          {scopes.length > 0 && (
            <div>
              <p className="mb-1.5 text-text-muted text-xs">
                {t("vault.mcpOAuth.grantedScopes", "Granted scopes")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {scopes.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center rounded-full bg-bg-hover px-2 py-0.5 font-mono text-text-secondary text-xs"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="danger" size="sm" onClick={askDisconnect}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              {t("vault.mcpOAuth.disconnect", "Disconnect")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <span className="text-sm text-text-muted">
            {t("vault.mcpOAuth.notConnected", "Not connected")}
          </span>
          <p className="text-text-muted text-xs">
            {t(
              "vault.mcpOAuth.signedInHint",
              "You must be signed in to the MCP server in your browser to approve access.",
            )}
          </p>
          <div className="flex justify-end">
            <Button onClick={handleConnect} loading={connecting}>
              <LogIn className="h-4 w-4" aria-hidden="true" />
              {t("vault.mcpOAuth.connect", "Connect")}
            </Button>
          </div>
        </div>
      )}

      {/* NOTE: render-always per docs/modals.md */}
      <ConfirmDialog modal={disconnectModal} />
    </div>
  );
}
