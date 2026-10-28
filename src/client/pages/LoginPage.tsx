import { KeyRound } from "lucide-react";
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
import { type User, useAuth } from "@/client/contexts/AuthContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { useGoogleSignIn } from "@/client/hooks/useGoogleSignIn";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import {
  PasskeyCancelled,
  passkeyAutofill,
  passkeyAutofillSupported,
  passkeysSupported,
  signInWithPasskey,
} from "@/client/lib/passkey";
import { resolveSafeRedirect } from "@/client/lib/safeRedirect";
import { cn } from "@/client/lib/utils";

// The MCP OAuth authorization endpoint sends anonymous visitors here with itself as the return
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
  const redirectTo =
    resolveSafeRedirect(searchParams.get("redirect"), window.location.origin) ??
    "/";
  const { user, login, providers, signupEnabled, passkeysEnabled } = useAuth();
  const refusal = useFieldRefusal(LOGIN_FIELDS);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const goToRedirect = () => {
    if (isServerNavigation(redirectTo)) window.location.assign(redirectTo);
    else navigate(redirectTo, { replace: true });
  };
  const { pending: googlePending, signIn: signInWithGoogle } = useGoogleSignIn({
    onError: setError,
    onSignedIn: goToRedirect,
  });
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [browserHasPasskeys] = useState(passkeysSupported);
  const showPasskey = passkeysEnabled && browserHasPasskeys;
  const authPending = loading || googlePending || passkeyPending;
  // Synchronous cross-method lock so a Google credential callback, a passkey and a form submit cannot
  // pass their guards together before React commits the pending state update.
  const authInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // The passkey offered in the email field's autofill: a request that waits in the background while
  // the form is on screen. A page holds one WebAuthn request at a time, so every other way in stops it
  // first and starts it again when that attempt fails. Read through refs so the effect and the
  // handlers always start the current render's version.
  const autofillRef = useRef<ReturnType<typeof passkeyAutofill> | null>(null);
  const stopAutofill = () => {
    autofillRef.current?.stop();
    autofillRef.current = null;
  };
  const startAutofillRef = useRef<() => void>(() => {});
  // Set once the browser says it has conditional mediation; until then nothing starts the request.
  const autofillSupportedRef = useRef(false);
  useEffect(() => {
    if (!showPasskey) return;
    let cancelled = false;
    void passkeyAutofillSupported().then((supported) => {
      autofillSupportedRef.current = supported;
      if (supported && !cancelled) startAutofillRef.current();
    });
    return () => {
      cancelled = true;
      autofillRef.current?.stop();
      autofillRef.current = null;
    };
  }, [showPasskey]);
  // What the inputs hold right now, readable from inside a request that started before it. Above the
  // early returns below, because a hook after a conditional return is not called on every render.
  const sentRef = useRef({ email, password });
  sentRef.current = { email, password };
  // Covers the already-logged-in visit; both sign-in paths navigate from their own handlers.
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
    stopAutofill();
    void signInWithGoogle(credential).finally(() => {
      authInFlightRef.current = false;
      // NOTE: a Google sign-in that failed gives the email field its passkey suggestions back; after
      // a success the page is gone and this does nothing.
      startAutofillRef.current();
    });
  };

  const passkeySignedIn = (next: User) => {
    login(next);
    goToRedirect();
  };

  const passkeyError = (e: unknown) =>
    apiErrorMessage(e) ||
    t(
      "auth.passkeySignInFailed",
      "Could not sign in with a passkey. Try again or use another way in.",
    );

  const handlePasskey = async () => {
    if (authInFlightRef.current) return;
    authInFlightRef.current = true;
    setError("");
    setPasskeyPending(true);
    stopAutofill();
    let succeeded = false;
    try {
      const next = await signInWithPasskey();
      succeeded = true;
      passkeySignedIn(next);
    } catch (e) {
      // NOTE: closing the browser's dialog is not an error.
      if (e instanceof PasskeyCancelled) return;
      setError(passkeyError(e));
    } finally {
      authInFlightRef.current = false;
      if (mountedRef.current) setPasskeyPending(false);
      if (!succeeded) startAutofillRef.current();
    }
  };

  startAutofillRef.current = () => {
    // NOTE: never while another way in is running (its request is the page's one WebAuthn request
    // then); whoever holds the lock starts it again when that attempt settles.
    if (
      !mountedRef.current ||
      !autofillSupportedRef.current ||
      authInFlightRef.current ||
      autofillRef.current
    ) {
      return;
    }
    const autofill = passkeyAutofill();
    autofillRef.current = autofill;
    let picked = false;
    let succeeded = false;
    void autofill
      .run(() => {
        if (authInFlightRef.current) return false;
        picked = true;
        authInFlightRef.current = true;
        setError("");
        setPasskeyPending(true);
        return true;
      })
      .then((next) => {
        succeeded = true;
        passkeySignedIn(next);
      })
      .catch((e) => {
        // NOTE: stopped by another way in, or the browser declined: silent.
        if (e instanceof PasskeyCancelled || !mountedRef.current) return;
        setError(passkeyError(e));
      })
      .finally(() => {
        if (autofillRef.current === autofill) autofillRef.current = null;
        if (!picked) return;
        authInFlightRef.current = false;
        if (mountedRef.current) setPasskeyPending(false);
        // NOTE: a passkey the server refused leaves the suggestions armed for the next try. Only
        // after a pick: a request the browser ended on its own is not restarted, or it could loop.
        if (!succeeded) startAutofillRef.current();
      });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (authInFlightRef.current) return;
    setError("");
    authInFlightRef.current = true;
    setLoading(true);
    stopAutofill();
    let signedIn = false;

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
        signedIn = true;
        login(data.user);
        goToRedirect();
      }
    } catch {
      setError(
        t("auth.genericError", "Something went wrong. Please try again."),
      );
    } finally {
      authInFlightRef.current = false;
      setLoading(false);
      if (!signedIn) startAutofillRef.current();
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
          )}

          {showPasskey && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              loading={passkeyPending}
              disabled={authPending}
              onClick={() => void handlePasskey()}
            >
              {!passkeyPending && <KeyRound className="size-4" aria-hidden />}
              {t("auth.signInWithPasskey", "Sign in with a passkey")}
            </Button>
          )}

          {(providers.google || showPasskey) && (
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-text-secondary text-xs uppercase">
                {t("auth.or", "or")}
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
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
              // NOTE: `webauthn` lets the browser offer this site's passkeys among the suggestions, next
              // to the saved password; with passkeys off it stays a plain username field.
              autoComplete={showPasskey ? "username webauthn" : undefined}
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
