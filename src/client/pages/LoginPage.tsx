import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import {
  BrandFooter,
  Button,
  GoogleSignInButton,
  Input,
  Logo,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { useGoogleSignIn } from "@/client/hooks/useGoogleSignIn";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";

// Only honor an in-app destination (a single leading slash); reject absolute or protocol-relative
// URLs so ?redirect= can never become an off-site open redirect.
function safeLocalPath(raw: string | null): string {
  if (!raw?.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

// NOTE: The MCP OAuth authorization endpoint sends anonymous visitors here with itself as the return
// destination. It is a SERVER route, not a SPA route, so react-router's navigate() would render a
// dead SPA path instead of resuming the OAuth flow — it needs a real browser navigation. Kept to
// this single exact path (never a general "/api/" prefix) so a crafted ?redirect= cannot turn login
// into a GET against an arbitrary endpoint.
const MCP_AUTHORIZE_PATH = "/api/v1/mcp/oauth/authorize";

export function isServerNavigation(path: string): boolean {
  return (
    path === MCP_AUTHORIZE_PATH || path.startsWith(`${MCP_AUTHORIZE_PATH}?`)
  );
}

// The two keys the login body carries. A wrong password answers without naming either — deliberately,
// since naming one would say which half was right — so what lands here in practice is the schema
// boundary refusing a malformed address.
const LOGIN_FIELDS = ["email", "password"] as const;

// biome-ignore lint/plugin/require-page-container: auth page renders its own centered layout outside <Layout>, so <PageContainer> does not apply
export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = safeLocalPath(searchParams.get("redirect"));
  const { user, login, providers, signupEnabled } = useAuth();
  const refusal = useFieldRefusal(LOGIN_FIELDS);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { pending: googlePending, signIn: signInWithGoogle } = useGoogleSignIn({
    onError: setError,
  });
  const authPending = loading || googlePending;
  // NOTE: Synchronous cross-method lock so a Google credential callback and a
  // form submit cannot both pass their guards before React commits the pending
  // state update.
  const authInFlightRef = useRef(false);
  // What the inputs hold right now, readable from inside a request that started before it. Above the
  // early returns below, because a hook after a conditional return is not called on every render.
  const sentRef = useRef({ email, password });
  sentRef.current = { email, password };
  // NOTE: Covers the already-logged-in visit and the Google callback (which only flips `user`); the
  // password path navigates from its own handler.
  const resumeServerFlow = user && isServerNavigation(redirectTo);
  useEffect(() => {
    if (resumeServerFlow) window.location.assign(redirectTo);
  }, [resumeServerFlow, redirectTo]);

  if (resumeServerFlow) return null;
  if (user) return <Navigate to={redirectTo} replace />;

  const handleGoogleCredential = (credential: string) => {
    if (authInFlightRef.current) return;
    authInFlightRef.current = true;
    setError("");
    void signInWithGoogle(credential).finally(() => {
      authInFlightRef.current = false;
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (authInFlightRef.current) return;
    setError("");
    authInFlightRef.current = true;
    setLoading(true);

    try {
      const sent = { email, password };
      const { data, error: apiError } = await api.api.auth.login.post(sent);

      if (apiError) {
        setError(
          refusal.capture(
            apiError,
            t("auth.loginFailed", "Login failed"),
            sent,
            sentRef.current,
          ) ?? "",
        );
        return;
      }

      refusal.clear();
      if (data?.user) {
        login(data.user);
        if (isServerNavigation(redirectTo)) window.location.assign(redirectTo);
        else navigate(redirectTo);
      }
    } catch {
      setError(
        t("auth.genericError", "Something went wrong. Please try again."),
      );
    } finally {
      authInFlightRef.current = false;
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-md">
        <div className="mb-12 text-center">
          <Logo className="mx-auto h-10" />
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-8"
        >
          <h1 className="mb-2 text-center font-semibold text-2xl text-text-primary">
            {t("auth.login", "Login")}
          </h1>

          {error && (
            <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
              {error}
            </div>
          )}

          {providers.google && (
            <>
              <div
                className={cn({ "opacity-50": authPending })}
                aria-busy={authPending}
              >
                <GoogleSignInButton
                  clientId={providers.google.clientId}
                  onCredential={handleGoogleCredential}
                  disabled={googlePending}
                  onError={() =>
                    setError(
                      t("auth.googleSignInFailed", "Google sign-in failed"),
                    )
                  }
                />
              </div>
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-text-secondary text-xs uppercase">
                  {t("auth.or", "or")}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <div>
            <label
              htmlFor="email"
              className="mb-1 block font-medium text-sm text-text-primary"
            >
              {t("auth.email", "Email")}
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={authPending}
              placeholder={t("auth.emailPlaceholder", "you@example.com")}
              error={!!refusal.at("email", email)}
              errorMessage={refusal.at("email", email) ?? undefined}
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
              disabled={authPending}
              placeholder="••••••••"
              error={!!refusal.at("password", password)}
              errorMessage={refusal.at("password", password) ?? undefined}
            />
          </div>

          <Button
            type="submit"
            loading={loading}
            disabled={authPending}
            className="w-full"
          >
            {loading
              ? t("auth.loggingIn", "Logging in...")
              : t("auth.login", "Login")}
          </Button>
        </form>

        {signupEnabled && (
          <p className="mt-4 text-center text-text-secondary">
            {t("auth.noAccount", "Don't have an account?")}{" "}
            <Link
              to="/signup"
              aria-label={t("auth.signup", "Sign Up")}
              className="font-medium text-accent hover:underline"
            >
              {t("auth.signup", "Sign Up")}
            </Link>
          </p>
        )}

        <BrandFooter />
      </div>
    </div>
  );
}
