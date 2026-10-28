import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { Badge, Button, Logo, Skeleton } from "@/client/components";
import { useToast } from "@/client/components/Toast";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { afterLogout } from "@/client/lib/logout";

// Standalone OAuth 2.1 consent screen (outside the app shell, like Login). /authorize parks a
// pending authorization and redirects here with ?req=<id>; we fetch its details, the user approves
// or denies, and we hand control back to the MCP client via the redirect the server computes (the
// code is minted server-side from the stored record, never trusted from this page).

type ConsentDetails = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof api.api.v1.mcp.oauth.consent>["get"]>
  >["data"]
>;

type Decision = "approve" | "deny";

// biome-ignore lint/plugin/require-page-container: consent page renders its own centered layout outside <Layout>, so <PageContainer> does not apply
export function OAuthConsentPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [req] = useState(() => searchParams.get("req") ?? "");
  const [state, setState] = useState<"loading" | "ready" | "invalid">(
    "loading",
  );
  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const inFlightRef = useRef(false);

  // Strip ?req from the URL once captured (history / Referer hygiene); the state keeps it.
  useEffect(() => {
    if (searchParams.has("req")) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!req) {
      setState("invalid");
      return;
    }
    let active = true;
    api.api.v1.mcp.oauth
      .consent({ req })
      .get()
      .then(({ data, error: apiError }) => {
        if (!active) return;
        if (apiError) {
          // Session expired between /authorize and here → bounce through login, preserving req.
          if (apiError.status === 401) {
            navigate(
              `/login?redirect=${encodeURIComponent(`/oauth/consent?req=${req}`)}`,
              { replace: true },
            );
            return;
          }
          setState("invalid");
          return;
        }
        if (!data) {
          setState("invalid");
          return;
        }
        setDetails(data);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("invalid");
      });
    return () => {
      active = false;
    };
  }, [req, navigate]);

  const decide = async (decision: Decision) => {
    // The server's own sentence is NOT shown here, and this is the one screen on the sweep where that
    // is the right answer. Measured: this endpoint's only two refusals are a bare
    // `UnauthorizedError()` and a bare `NotFoundError()` — "Unauthorized" and "Not found" — and the
    // second is the ordinary case (the pending authorization expired, was consumed in another tab, or
    // the CSRF token no longer matches). Showing "Not found" would cost the only recovery action the
    // person has and give nothing back. The better fix is on the server, where that 404 could carry a
    // key saying what expired; until it does, the client's words are the more specific ones.
    const generic = t(
      "oauth.consent.genericError",
      "Something went wrong. Reconnect from the application to try again.",
    );
    if (!details || inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(decision);
    setError("");
    try {
      const { data, error: apiError } = await api.api.v1.mcp.oauth
        .consent({ req })
        .post({ decision, csrfToken: details.csrfToken });
      if (apiError || !data?.redirect) {
        setError(generic);
        return;
      }
      // Hand control back to the MCP client (full navigation to its redirect URI).
      window.location.assign(data.redirect);
    } catch {
      setError(generic);
    } finally {
      inFlightRef.current = false;
      setSubmitting(null);
    }
  };

  const scopeLabel = (scope: string): string => {
    switch (scope) {
      case "mcp:read":
        return t(
          "oauth.consent.scope.mcpRead",
          "Read your data (conversations, agents, settings)",
        );
      case "mcp:write":
        return t(
          "oauth.consent.scope.mcpWrite",
          "Change agent settings on your behalf",
        );
      case "mcp:admin":
        return t(
          "oauth.consent.scope.mcpAdmin",
          "Global administration (visual identity)",
        );
      default:
        return scope;
    }
  };

  const switchAccount = () => {
    // The navigation is the SECOND half of switching, and it only means anything once the first one
    // happened: `/login` sends a still-signed-in visitor straight back here as the same operator, so
    // a failed logout made this button do nothing at all, silently.
    void logout().then((ended) =>
      afterLogout(
        ended,
        () =>
          navigate(
            `/login?redirect=${encodeURIComponent(`/oauth/consent?req=${req}`)}`,
            { replace: true },
          ),
        () =>
          showToast(
            t("auth.logoutFailed", "Could not sign you out. Please try again."),
            "error",
          ),
      ),
    );
  };

  return (
    <div className="bg-bg-primary flex min-h-dvh flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-12 text-center">
          <Logo className="mx-auto h-10" />
        </div>

        {state === "loading" ? (
          <div
            role="status"
            className="border-border bg-bg-secondary space-y-4 rounded-2xl border p-8"
          >
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="mx-auto h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : state === "invalid" ? (
          <div className="border-border bg-bg-secondary space-y-4 rounded-2xl border p-8 text-center">
            <h1 className="text-text-primary text-xl font-semibold">
              {t("oauth.consent.expiredTitle", "Request unavailable")}
            </h1>
            <p className="text-text-secondary text-sm">
              {t(
                "oauth.consent.expiredBody",
                "This authorization request is invalid or has expired. Reconnect from the application to try again.",
              )}
            </p>
          </div>
        ) : details ? (
          <div className="border-border bg-bg-secondary space-y-6 rounded-2xl border p-8">
            <div className="space-y-1 text-center">
              <h1 className="text-text-primary text-xl font-semibold">
                {t("oauth.consent.title", "{{client}} wants access", {
                  client: details.clientName,
                })}
              </h1>
              <p className="text-text-secondary text-sm">
                {t(
                  "oauth.consent.subtitle",
                  "Approve this application to connect to your account.",
                )}
              </p>
            </div>

            {details.unverified ? (
              <div className="border-warning bg-warning-soft text-text-primary flex items-start gap-2 rounded-lg border px-4 py-3 text-sm">
                <AlertTriangle
                  className="text-warning mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <p className="font-medium">
                    {t(
                      "oauth.consent.unverifiedTitle",
                      "Unverified application",
                    )}
                  </p>
                  <p className="text-text-secondary text-xs">
                    {t(
                      "oauth.consent.unverifiedBody",
                      "Anyone can register an application under this name. Approve only if you started this connection and trust that it redirects to {{host}}.",
                      { host: details.redirectHost },
                    )}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="border-border bg-bg-primary rounded-lg border p-4">
              <p className="text-text-primary mb-2 text-sm font-medium">
                {t("oauth.consent.scopesTitle", "This will allow it to:")}
              </p>
              <ul className="space-y-2">
                {details.scopes.length === 0 ? (
                  <li className="text-text-secondary text-sm">
                    {t("oauth.consent.noScopes", "No access is requested.")}
                  </li>
                ) : (
                  details.scopes.map((scope) => (
                    <li
                      key={scope}
                      className="text-text-secondary flex items-start gap-2 text-sm"
                    >
                      <Badge variant="secondary">{scope}</Badge>
                      <span>{scopeLabel(scope)}</span>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">
                  {t("oauth.consent.account", "Signed in as")}
                </dt>
                <dd className="text-text-primary truncate">
                  {details.accountEmail}
                </dd>
              </div>
              {details.tenantName ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">
                    {t("oauth.consent.workspace", "Workspace")}
                  </dt>
                  <dd className="text-text-primary truncate">
                    {details.tenantName}
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">
                  {t("oauth.consent.redirectTo", "Redirects to")}
                </dt>
                <dd className="text-text-primary truncate font-medium">
                  {details.redirectHost}
                </dd>
              </div>
            </dl>

            {error && (
              <div className="border-error bg-error-soft text-error rounded-lg border px-4 py-2 text-sm">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                loading={submitting === "deny"}
                disabled={submitting !== null}
                onClick={() => void decide("deny")}
              >
                {t("oauth.consent.deny", "Deny")}
              </Button>
              <Button
                type="button"
                className="flex-1"
                loading={submitting === "approve"}
                disabled={submitting !== null}
                onClick={() => void decide("approve")}
              >
                {t("oauth.consent.approve", "Approve")}
              </Button>
            </div>

            <button
              type="button"
              onClick={switchAccount}
              disabled={submitting !== null}
              className="text-text-secondary hover:text-text-primary block w-full text-center text-xs"
            >
              {t("oauth.consent.switchAccount", "Not you? Use another account")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
