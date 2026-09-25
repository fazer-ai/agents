import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button, Input, Logo } from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { setActiveTenantId } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import type { ApiErrorPayload } from "@/client/lib/types";

type ValidationState = "validating" | "valid" | "invalid";

// An invitation waiting in this tab while its invitee signs in (the token never goes back on a URL,
// for the same history / Referer hygiene the page strips it for). It stays parked until the
// invitation is accepted or turns out to be invalid: signing in can end in a full reload (the
// selector recovery after /auth/me), and a token cleared on the first read would be gone by then
// (review round 7).
const PARKED_INVITE_KEY = "@app:parked-invite";

function parkInviteToken(token: string): void {
  try {
    sessionStorage.setItem(PARKED_INVITE_KEY, token);
  } catch {
    // Storage unavailable: signing in still works, the invitation link just has to be reopened.
  }
}

function readParkedInviteToken(): string | null {
  try {
    return sessionStorage.getItem(PARKED_INVITE_KEY);
  } catch {
    return null;
  }
}

function clearParkedInvite(): void {
  try {
    sessionStorage.removeItem(PARKED_INVITE_KEY);
  } catch {
    // Nothing parked that could be read either.
  }
}

// Public invite-acceptance page. Modeled on SetupPage: capture ?token, strip it from the URL, validate
// it to pre-fill the (read-only) email, then join + auto-login. tenant + role are bound server-side to
// the invite. Three shapes, because one person is one account across tenants (issue #756):
//   - the email has no account yet: set a name and a password, and the account is created;
//   - the email has an account and this browser is signed in as it: one click joins the tenant;
//   - the email has an account and this browser is not signed in as it: its CURRENT password proves
//     it, and nothing about the account changes besides the new membership.
// Either way the console then opens on the tenant just joined.
// biome-ignore lint/plugin/require-page-container: auth page renders its own centered layout outside <Layout>, so <PageContainer> does not apply
export function AcceptInvitePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, login, logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [token] = useState(
    () => searchParams.get("token") ?? readParkedInviteToken() ?? "",
  );
  const [state, setState] = useState<ValidationState>("validating");
  const [email, setEmail] = useState("");
  const [existingAccount, setExistingAccount] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  // Strip the token from the URL once captured (history / Referer hygiene); the state keeps it.
  useEffect(() => {
    if (searchParams.has("token")) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  // Validate the token to pre-fill the form (generic invalid on any missing/expired/used token).
  useEffect(() => {
    if (!token) {
      setState("invalid");
      return;
    }
    let active = true;
    api.api.auth.invite
      .get({ query: { token } })
      .then(({ data, error: apiError }) => {
        if (!active) return;
        if (apiError || !data?.invite) {
          clearParkedInvite();
          setState("invalid");
          return;
        }
        setEmail(data.invite.email);
        setExistingAccount(data.invite.existingAccount);
        setState("valid");
      })
      .catch(() => {
        if (active) setState("invalid");
      });
    return () => {
      active = false;
    };
  }, [token]);

  const signedInAsInvitee =
    user !== null && user.email.toLowerCase() === email.toLowerCase();
  const joinsExisting = existingAccount || signedInAsInvitee;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current) return;
    setError("");
    if (!joinsExisting && password !== confirmPassword) {
      setError(t("auth.passwordsNoMatch", "Passwords do not match"));
      return;
    }
    inFlightRef.current = true;
    setLoading(true);
    try {
      const { data, error: apiError } = await api.api.auth[
        "accept-invite"
      ].post({
        token,
        password: signedInAsInvitee ? undefined : password,
        name: joinsExisting ? undefined : name.trim() || undefined,
      });
      if (apiError) {
        setError(
          (apiError.value as ApiErrorPayload)?.error ||
            t("acceptInvite.failed", "Could not accept the invitation"),
        );
        return;
      }
      if (data?.user) {
        clearParkedInvite();
        // Open the console on the tenant just joined, which for a person with other tenants is not
        // necessarily their default.
        setActiveTenantId(data.user.tenantId);
        if (user) {
          // A session was already running, built for another tenant: reload onto the new one.
          window.location.assign("/");
          return;
        }
        login(data.user);
        navigate("/");
      }
    } catch {
      setError(
        t("auth.genericError", "Something went wrong. Please try again."),
      );
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  // An account that signs in with Google has no password to enter on this page: signing in proves it
  // the same way, with the invitation parked in this tab until the invitee comes back.
  const switchToSignIn = async () => {
    parkInviteToken(token);
    // Signed in as somebody else, the login page would bounce straight back here: that
    // session ends first, and only once the server says it ended (review round 5).
    if (user && !(await logout())) {
      setError(
        t("auth.genericError", "Something went wrong. Please try again."),
      );
      return;
    }
    navigate(`/login?redirect=${encodeURIComponent("/accept-invite")}`);
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-md">
        <div className="mb-12 text-center">
          <Logo className="mx-auto h-10" />
        </div>

        {state === "validating" ? (
          <div className="flex items-center justify-center rounded-2xl border border-border bg-bg-secondary p-8">
            <Loader2 className="h-6 w-6 animate-spin text-text-secondary" />
            <span className="ml-3 text-sm text-text-secondary">
              {t("acceptInvite.validating", "Validating invitation…")}
            </span>
          </div>
        ) : state === "invalid" ? (
          <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-8 text-center">
            <h1 className="font-semibold text-text-primary text-xl">
              {t("acceptInvite.invalidTitle", "Invitation unavailable")}
            </h1>
            <p className="text-sm text-text-secondary">
              {t(
                "acceptInvite.invalid",
                "This invitation link is invalid or has expired.",
              )}
            </p>
            <Link
              to="/login"
              className="inline-block text-accent text-sm hover:underline"
            >
              {t("acceptInvite.toLogin", "Go to login")}
            </Link>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-8"
          >
            <div className="mb-2 text-center">
              <h1 className="font-semibold text-2xl text-text-primary">
                {t("acceptInvite.title", "Accept your invitation")}
              </h1>
              <p className="mt-1 text-sm text-text-secondary">
                {signedInAsInvitee
                  ? t(
                      "acceptInvite.signedInSubtitle",
                      "You are signed in with this email. Join to add this tenant to your account.",
                    )
                  : existingAccount
                    ? t(
                        "acceptInvite.existingSubtitle",
                        "This email already has an account. Enter its password to add this tenant to it.",
                      )
                    : t(
                        "acceptInvite.subtitle",
                        "Set a password to activate your account.",
                      )}
              </p>
            </div>

            {error && (
              <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="mb-1 block font-medium text-sm text-text-primary"
              >
                {t("auth.email", "Email")}
              </label>
              <Input id="email" type="email" value={email} disabled readOnly />
            </div>

            {!joinsExisting && (
              <>
                <div>
                  <label
                    htmlFor="name"
                    className="mb-1 block font-medium text-sm text-text-primary"
                  >
                    {t("common.name", "Name")}
                  </label>
                  <Input
                    id="name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={loading}
                    placeholder={t("acceptInvite.namePlaceholder", "Optional")}
                  />
                </div>

                <div>
                  <label
                    htmlFor="password"
                    className="mb-1 block font-medium text-sm text-text-primary"
                  >
                    {t("auth.password", "Password")}
                  </label>
                  <Input
                    id="password"
                    type="password"
                    showPasswordToggle
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    disabled={loading}
                    placeholder="••••••••"
                    helperText={t(
                      "auth.passwordMinLength",
                      "Must be at least 8 characters",
                    )}
                  />
                </div>

                <div>
                  <label
                    htmlFor="confirmPassword"
                    className="mb-1 block font-medium text-sm text-text-primary"
                  >
                    {t("auth.confirmPassword", "Confirm Password")}
                  </label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    showPasswordToggle
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                    disabled={loading}
                    placeholder="••••••••"
                  />
                </div>
              </>
            )}
            {existingAccount && !signedInAsInvitee && (
              <div>
                <label
                  htmlFor="password"
                  className="mb-1 block font-medium text-sm text-text-primary"
                >
                  {t("acceptInvite.currentPassword", "Current password")}
                </label>
                <Input
                  id="password"
                  type="password"
                  showPasswordToggle
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  placeholder="••••••••"
                />
                {/* An account that signs in with Google has no password to enter here. Signing in
                    first proves the account the same way, and the invitation waits in this tab. */}
                <button
                  type="button"
                  onClick={switchToSignIn}
                  className="mt-2 text-accent text-sm hover:underline"
                >
                  {user
                    ? t(
                        "acceptInvite.switchAccount",
                        "Sign out and sign in to this account (Google included)",
                      )
                    : t(
                        "acceptInvite.signInInstead",
                        "Sign in to this account instead (Google included)",
                      )}
                </button>
              </div>
            )}

            <Button
              type="submit"
              loading={loading}
              disabled={loading}
              className="w-full"
            >
              {loading
                ? t("acceptInvite.submitting", "Activating…")
                : joinsExisting
                  ? t("acceptInvite.join", "Join")
                  : t("acceptInvite.submit", "Activate account")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
