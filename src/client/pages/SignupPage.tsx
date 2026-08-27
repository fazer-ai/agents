import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate } from "react-router";
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

// The two keys the signup body carries. An address that already has an account answers 400 "Email
// already in use" and names `email` — the whole reason this page can place anything.
const SIGNUP_FIELDS = ["email", "password"] as const;

// biome-ignore lint/plugin/require-page-container: auth page renders its own centered layout outside <Layout>, so <PageContainer> does not apply
export function SignupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, login, providers, signupEnabled } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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
  const refusal = useFieldRefusal(SIGNUP_FIELDS);
  // What the inputs hold right now, readable from inside a request that started before it. Above the
  // early returns below, because a hook after a conditional return is not called on every render.
  const sentRef = useRef({ email, password });
  sentRef.current = { email, password };

  if (user) return <Navigate to="/" replace />;
  // NOTE: Public signup is opt-in (SIGNUP_ENABLED). When closed, the page is
  // unreachable; SetupGate already covers the first-run case.
  if (!signupEnabled) return <Navigate to="/login" replace />;

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

    if (password !== confirmPassword) {
      setError(t("auth.passwordsNoMatch", "Passwords do not match"));
      return;
    }

    authInFlightRef.current = true;
    setLoading(true);

    try {
      const sent = { email, password };
      const { data, error: apiError } = await api.api.auth.signup.post(sent);

      if (apiError) {
        setError(
          refusal.capture(
            apiError,
            t("auth.signupFailed", "Signup failed"),
            sent,
            sentRef.current,
          ) ?? "",
        );
        return;
      }

      refusal.clear();
      if (data?.user) {
        login(data.user);
        navigate("/");
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
            {t("auth.createAccount", "Create Account")}
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
              disabled={authPending}
              placeholder="••••••••"
            />
          </div>

          <Button
            type="submit"
            loading={loading}
            disabled={authPending}
            className="w-full"
          >
            {loading
              ? t("auth.creatingAccount", "Creating account...")
              : t("auth.signup", "Sign Up")}
          </Button>
        </form>

        <p className="mt-4 text-center text-text-secondary">
          {t("auth.hasAccount", "Already have an account?")}{" "}
          <Link to="/login" className="font-medium text-accent hover:underline">
            {t("auth.login", "Login")}
          </Link>
        </p>

        <BrandFooter />
      </div>
    </div>
  );
}
