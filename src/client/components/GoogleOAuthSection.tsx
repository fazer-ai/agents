import { Check, Copy, ExternalLink, Loader2, LogOut } from "lucide-react";
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
// NOTE: `vault` is a function (takes the id param), so we call it with a placeholder to get the
// inner chain type, then access .oauth.google.status.get which is the actual fetch function.
type OAuthStatus = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<typeof api.api.v1.vault>["oauth"]["google"]["status"]["get"]
    >
  >["data"]
>;

// `api` is the googleapis.com service id whose Google Cloud Marketplace page enables the API for
// the operator's project (the consent works without it, but calls fail until the API is enabled).
const PREDEFINED_SCOPES: {
  key: string;
  scope: string;
  api?: string;
  restricted?: boolean;
}[] = [
  {
    key: "calendar",
    scope: "https://www.googleapis.com/auth/calendar",
    api: "calendar-json.googleapis.com",
  },
  {
    key: "drive_file",
    scope: "https://www.googleapis.com/auth/drive.file",
    api: "drive.googleapis.com",
  },
  {
    // Read-only access to ALL the account's Drive files/folders. Required by the folder picker and by
    // drive_find_file to see existing files — drive.file only sees files this app itself created.
    key: "drive_readonly",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    api: "drive.googleapis.com",
    restricted: true,
  },
  {
    key: "drive",
    scope: "https://www.googleapis.com/auth/drive",
    api: "drive.googleapis.com",
    restricted: true,
  },
  {
    key: "sheets",
    scope: "https://www.googleapis.com/auth/spreadsheets",
    api: "sheets.googleapis.com",
  },
  {
    key: "gmail",
    scope: "https://www.googleapis.com/auth/gmail.modify",
    api: "gmail.googleapis.com",
    restricted: true,
  },
  {
    key: "contacts",
    scope: "https://www.googleapis.com/auth/contacts",
    api: "people.googleapis.com",
  },
  {
    key: "tasks",
    scope: "https://www.googleapis.com/auth/tasks",
    api: "tasks.googleapis.com",
  },
];

const MARKETPLACE_URL =
  "https://console.cloud.google.com/marketplace/product/google/";

// Per-scope label keys. Magic comments register the dynamic keys for the i18n extractor.
// t('vault.googleOAuth.scopeCalendar', 'Google Calendar')
// t('vault.googleOAuth.scopeDriveFile', 'Drive (app files)')
// t('vault.googleOAuth.scopeDriveReadonly', 'Drive (read-only)')
// t('vault.googleOAuth.scopeDrive', 'Drive (full access)')
// t('vault.googleOAuth.scopeSheets', 'Google Sheets')
// t('vault.googleOAuth.scopeGmail', 'Gmail')
// t('vault.googleOAuth.scopeContacts', 'Google Contacts')
// t('vault.googleOAuth.scopeTasks', 'Google Tasks')
const SCOPE_LABEL_KEYS: Record<string, string> = {
  calendar: "vault.googleOAuth.scopeCalendar",
  drive_file: "vault.googleOAuth.scopeDriveFile",
  drive_readonly: "vault.googleOAuth.scopeDriveReadonly",
  drive: "vault.googleOAuth.scopeDrive",
  sheets: "vault.googleOAuth.scopeSheets",
  gmail: "vault.googleOAuth.scopeGmail",
  contacts: "vault.googleOAuth.scopeContacts",
  tasks: "vault.googleOAuth.scopeTasks",
};

interface GoogleOAuthSectionProps {
  // The saved entry's id, or null when the credential hasn't been created yet (create mode). When
  // null, connecting first persists the credential via onEnsureSaved.
  entryId: string | null;
  // Whether the OAuth flow can start: the credential has a usable Client ID + Client secret (both
  // filled now, or already stored on a saved entry with no partial edit). Gates the connect button.
  canConnect: boolean;
  // Persists the credential (creates it, or saves edited client fields) and returns its id BEFORE the
  // OAuth flow starts — so the operator never has to save, close and reopen just to connect. Returns
  // null when the save fails or the inputs are invalid (a toast is shown by the parent).
  onEnsureSaved?: () => Promise<string | null>;
}

// The official 4-color Google "G". Inlined (like GithubIcon) so the connect button matches the
// recognizable "Sign in with Google" mark. Brand colors are fixed by Google's guidelines — the one
// place hardcoded hex is correct rather than theme variables.
function GoogleGLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      aria-hidden="true"
      role="img"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

// Google OAuth connection section shown inside CredentialForm whenever kind === "google_oauth"
// (create AND update). Manages the authorize → popup → status cycle. Connecting first persists the
// credential via onEnsureSaved (one click, no save → close → reopen); the connect button is gated on
// canConnect (a usable Client ID + secret). entryId is null until the entry exists.
//
// t('vault.googleOAuth.sectionTitle', 'Google connection')
// t('vault.googleOAuth.redirectUri', 'Redirect URI')
// t('vault.googleOAuth.redirectUriHint', 'Register this URL as an authorized redirect URI in the Google Cloud Console.')
// t('vault.googleOAuth.connected', 'Connected as {{email}}')
// t('vault.googleOAuth.notConnected', 'Not connected')
// t('vault.googleOAuth.scopesLabel', 'Scopes')
// t('vault.googleOAuth.grantedScopes', 'Granted scopes')
// t('vault.googleOAuth.scopeRestricted', 'Restricted scope — requires Google verification')
// t('vault.googleOAuth.extraScopes', 'Additional scopes')
// t('vault.googleOAuth.extraScopesHint', 'One scope per line or space-separated (https://www.googleapis.com/auth/...).')
// t('vault.googleOAuth.emailIncluded', 'Email access is always included to identify the account.')
// t('vault.googleOAuth.connect', 'Sign in with Google')
// t('vault.googleOAuth.disconnect', 'Disconnect')
// t('vault.googleOAuth.disconnectTitle', 'Disconnect Google account')
// t('vault.googleOAuth.disconnectMessage', 'This will revoke the stored tokens and disconnect the Google account from this credential.')
// t('vault.googleOAuth.connected_toast', 'Google account connected.')
// t('vault.googleOAuth.disconnected_toast', 'Google account disconnected.')
// t('vault.googleOAuth.connectError', 'Could not start the authorization flow.')
// t('vault.googleOAuth.popupBlocked', 'The popup was blocked. Allow popups for this site and try again.')
// t('vault.googleOAuth.authFailed', 'Authorization failed: {{message}}')
// t('vault.googleOAuth.needClientFields', 'Enter the Client ID and Client secret to connect.')

// The OAuth redirect URI to register in the Google Cloud Console, with copy + a console shortcut.
// Rendered by CredentialForm ABOVE the Client ID/secret fields because the operator needs this URL
// FIRST: you paste it into the console when creating the OAuth client, which is what mints the id +
// secret. Self-contained (own copy state) so it lives outside GoogleOAuthSection's connect cycle.
export function GoogleRedirectUriField() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const redirectUri = `${window.location.origin}/api/v1/oauth/google/callback`;

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

  return (
    <FormField
      label={t("vault.googleOAuth.redirectUri", "Redirect URI")}
      group
      description={t(
        "vault.googleOAuth.redirectUriHint",
        "Register this URL as an authorized redirect URI in the Google Cloud Console.",
      )}
    >
      <div className="flex items-center gap-2">
        <Input
          value={redirectUri}
          readOnly
          className="font-mono text-xs"
          aria-label={t("vault.googleOAuth.redirectUri", "Redirect URI")}
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
        <Tooltip content="Google Cloud Console">
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Google Cloud Console"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-secondary text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        </Tooltip>
      </div>
    </FormField>
  );
}

export function GoogleOAuthSection({
  entryId,
  canConnect,
  onEnsureSaved,
}: GoogleOAuthSectionProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(
    () => new Set(["calendar"]),
  );
  const [extraScopes, setExtraScopes] = useState("");
  const [connecting, setConnecting] = useState(false);

  const disconnectModal = useModalController<{
    title: string;
    message?: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
  }>();

  // Cancels the in-flight popup watcher on unmount (avoids setState after the modal closes).
  const watcherCancelRef = useRef<(() => void) | null>(null);

  // Re-reads the server (the source of truth: the callback persists tokens server-side) and reflects
  // it, returning whether the credential is now connected. No skeleton flash — used post-popup. Takes
  // an explicit id (the just-created entry's) since the prop may not have updated yet within a connect.
  const refreshStatus = useCallback(
    async (idArg?: string | null): Promise<boolean> => {
      const id = idArg ?? entryId;
      if (!id) return false;
      try {
        const { data } = await api.api.v1
          .vault({ id })
          .oauth.google.status.get();
        if (data) setStatus(data as OAuthStatus);
        return !!(data as OAuthStatus | null)?.connected;
      } catch {
        return false;
      }
    },
    [entryId],
  );

  const fetchStatus = useCallback(async () => {
    // Create mode (no entry yet) has nothing to read → render the not-connected actions immediately.
    if (!entryId) {
      setStatus(null);
      setStatusLoading(false);
      return;
    }
    setStatusLoading(true);
    try {
      await refreshStatus();
    } finally {
      setStatusLoading(false);
    }
  }, [entryId, refreshStatus]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => () => watcherCancelRef.current?.(), []);

  function toggleScope(key: string) {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function buildScopeList(): string[] {
    const scopes: string[] = [];
    for (const item of PREDEFINED_SCOPES) {
      if (selectedScopes.has(item.key)) scopes.push(item.scope);
    }
    for (const raw of extraScopes.split(/[\n\s]+/)) {
      const s = raw.trim();
      if (s?.startsWith("https://www.googleapis.com/auth/")) scopes.push(s);
    }
    return scopes;
  }

  async function handleConnect() {
    if (!canConnect || connecting) return;
    setConnecting(true);

    // Persist the credential first (create it, or save edited Client ID/secret), then authorize with
    // its id — so the operator connects in one click instead of save → close → reopen.
    let id = entryId;
    if (onEnsureSaved) {
      const saved = await onEnsureSaved();
      if (!saved) {
        setConnecting(false);
        return;
      }
      id = saved;
    }
    if (!id) {
      setConnecting(false);
      return;
    }

    let url: string;
    try {
      const scopes = buildScopeList();
      const { data, error: err } = await api.api.v1
        .vault({ id })
        .oauth.google.authorize.post({ scopes });
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ||
            t(
              "vault.googleOAuth.connectError",
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
          "vault.googleOAuth.connectError",
          "Could not start the authorization flow.",
        ),
        "error",
      );
      setConnecting(false);
      return;
    }

    const popup = window.open(url, "google-oauth", "width=500,height=700");
    if (!popup) {
      showToast(
        t(
          "vault.googleOAuth.popupBlocked",
          "The popup was blocked. Allow popups for this site and try again.",
        ),
        "error",
      );
      setConnecting(false);
      return;
    }

    const { result, cancel } = watchOAuthPopup({
      channel: "oauth-google",
      messageType: "google-oauth",
      pollStatus: () => refreshStatus(id),
    });
    watcherCancelRef.current = cancel;
    const outcome = await result;
    watcherCancelRef.current = null;
    setConnecting(false);

    if (outcome.type === "error") {
      showToast(
        t("vault.googleOAuth.authFailed", "Authorization failed: {{message}}", {
          message: outcome.message ?? "unknown",
        }),
        "error",
      );
      return;
    }

    // success | timeout → reflect the server's truth. On timeout this catches a late success the
    // poll/message both missed; a timeout with no connection means the operator abandoned consent →
    // stay silent.
    const connected = await refreshStatus(id);
    if (connected) {
      showToast(
        t("vault.googleOAuth.connected_toast", "Google account connected."),
        "success",
      );
    }
  }

  async function handleDisconnect() {
    if (!entryId) return;
    const { error: err } = await api.api.v1
      .vault({ id: entryId })
      .oauth.google.disconnect.post({});
    if (err) throw err;
    showToast(
      t("vault.googleOAuth.disconnected_toast", "Google account disconnected."),
      "success",
    );
    await fetchStatus();
  }

  function askDisconnect() {
    disconnectModal.open({
      title: t(
        "vault.googleOAuth.disconnectTitle",
        "Disconnect Google account",
      ),
      message: t(
        "vault.googleOAuth.disconnectMessage",
        "This will revoke the stored tokens and disconnect the Google account from this credential.",
      ),
      danger: true,
      onConfirm: handleDisconnect,
    });
  }

  const isConnected = !!status?.connected;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-tertiary p-4">
      <p className="font-medium text-sm text-text-primary">
        {t("vault.googleOAuth.sectionTitle", "Google connection")}
      </p>

      {/* Connection status + connect/disconnect actions */}
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
              {t("vault.googleOAuth.connected", "Connected as {{email}}", {
                email: status?.email ?? "",
              })}
            </span>
          </div>

          {status?.scopes && status.scopes.length > 0 && (
            <div>
              <p className="mb-1.5 text-text-muted text-xs">
                {t("vault.googleOAuth.grantedScopes", "Granted scopes")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {status.scopes.map((s) => {
                  const item = PREDEFINED_SCOPES.find((p) => p.scope === s);
                  const label = item
                    ? // biome-ignore lint/plugin/no-dynamic-i18n-key: scope label keys registered via magic comments above
                      t(SCOPE_LABEL_KEYS[item.key] ?? item.key, item.key)
                    : s.replace("https://www.googleapis.com/auth/", "");
                  return (
                    <span
                      key={s}
                      className="inline-flex items-center rounded-full bg-bg-hover px-2 py-0.5 text-text-secondary text-xs"
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button variant="danger" size="sm" onClick={askDisconnect}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              {t("vault.googleOAuth.disconnect", "Disconnect")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Scope selection checkboxes */}
          <FormField
            label={t("vault.googleOAuth.scopesLabel", "Scopes")}
            group
            description={t(
              "vault.googleOAuth.emailIncluded",
              "Email access is always included to identify the account.",
            )}
          >
            <div className="flex flex-col gap-2">
              {PREDEFINED_SCOPES.map((item) => {
                const checked = selectedScopes.has(item.key);
                return (
                  <label
                    key={item.key}
                    className="flex items-center gap-2.5 text-sm text-text-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleScope(item.key)}
                      className="h-4 w-4 rounded border-border accent-accent"
                    />
                    <span className="flex items-center gap-1.5">
                      {/* biome-ignore lint/plugin/no-dynamic-i18n-key: scope label keys registered via magic comments above */}
                      {t(SCOPE_LABEL_KEYS[item.key] ?? item.key, item.key)}
                      {item.api && (
                        <Tooltip
                          content={t(
                            "vault.googleOAuth.enableApiHint",
                            "Enable this API in your Google Cloud project",
                          )}
                        >
                          <a
                            href={`${MARKETPLACE_URL}${item.api}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t(
                              "vault.googleOAuth.enableApiHint",
                              "Enable this API in your Google Cloud project",
                            )}
                            className="inline-flex h-4 w-4 items-center justify-center text-text-muted transition-colors hover:text-text-primary"
                          >
                            <ExternalLink
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          </a>
                        </Tooltip>
                      )}
                      {item.restricted && (
                        <Tooltip
                          content={t(
                            "vault.googleOAuth.scopeRestricted",
                            "Restricted scope — requires Google verification",
                          )}
                        >
                          <button
                            type="button"
                            className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-warning bg-transparent font-medium text-[10px] text-warning"
                            aria-label={t(
                              "vault.googleOAuth.scopeRestricted",
                              "Restricted scope — requires Google verification",
                            )}
                          >
                            {/* biome-ignore lint/style/noJsxLiterals: decorative glyph */}
                            !
                          </button>
                        </Tooltip>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </FormField>

          {/* Extra scopes (free-text) */}
          <FormField
            label={t("vault.googleOAuth.extraScopes", "Additional scopes")}
            description={
              <>
                {t(
                  "vault.googleOAuth.extraScopesHint",
                  "One scope per line or space-separated (https://www.googleapis.com/auth/...).",
                )}{" "}
                <a
                  href="https://developers.google.com/identity/protocols/oauth2/scopes"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {t("vault.googleOAuth.scopesDocLink", "Full scope list")}
                </a>
              </>
            }
          >
            <textarea
              value={extraScopes}
              onChange={(e) => setExtraScopes(e.target.value)}
              rows={2}
              placeholder="https://www.googleapis.com/auth/..."
              className="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 font-mono text-sm text-text-primary placeholder-text-placeholder focus:border-border-focus focus:outline-none"
              aria-label={t(
                "vault.googleOAuth.extraScopes",
                "Additional scopes",
              )}
            />
          </FormField>

          {!canConnect && (
            <p className="text-text-muted text-xs">
              {t(
                "vault.googleOAuth.needClientFields",
                "Enter the Client ID and Client secret to connect.",
              )}
            </p>
          )}

          <div className="flex justify-end">
            {/* Google-branded connect button: white surface + the 4-color G, per Google's "Sign in
                with Google" guidelines (the recognizable affordance). It saves the credential then
                starts the OAuth flow in one click. */}
            <button
              type="button"
              onClick={handleConnect}
              disabled={!canConnect || connecting}
              className="inline-flex items-center justify-center gap-3 rounded-lg border border-[#dadce0] bg-white px-4 py-2.5 font-medium text-[#1f1f1f] text-sm shadow-sm transition-colors hover:bg-[#f8f9fa] disabled:opacity-60"
            >
              {connecting ? (
                <Loader2
                  className="h-5 w-5 animate-spin text-[#1f1f1f]"
                  aria-hidden="true"
                />
              ) : (
                <GoogleGLogo className="h-5 w-5" />
              )}
              {t("vault.googleOAuth.connect", "Sign in with Google")}
            </button>
          </div>
        </div>
      )}

      {/* NOTE: render-always per docs/modals.md */}
      <ConfirmDialog modal={disconnectModal} />
    </div>
  );
}
