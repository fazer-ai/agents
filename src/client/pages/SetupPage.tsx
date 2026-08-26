import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { BrandFooter, Button, Input, Logo } from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { setActiveTenantId } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";

// The keys the setup body carries. `email` is the one that refuses in practice: an address that
// already has an account answers 400 "Email already in use" and names it.
const SETUP_FIELDS = ["email", "password", "name", "companyName"] as const;

// `token` only where enforcement is on. The box is drawn behind `setupTokenRequired`, but a token
// captured from `?token=` is SENT either way, so the route can refuse it (the schema caps it at 256)
// on a screen with no control for it. Declaring it there would place the sentence on nothing and
// leave the button looking dead.
const SETUP_FIELDS_WITH_TOKEN = [...SETUP_FIELDS, "token"] as const;

// biome-ignore lint/plugin/require-page-container: auth page renders its own centered layout outside <Layout>, so <PageContainer> does not apply
export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, login, setupTokenRequired, refresh } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [token, setToken] = useState(() => searchParams.get("token") ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refusal = useFieldRefusal(
    setupTokenRequired ? SETUP_FIELDS_WITH_TOKEN : SETUP_FIELDS,
  );
  // What the inputs hold right now, in the server's vocabulary, and what the write sends. Above the
  // early return below, because a hook after a conditional return is not called on every render.
  const current = {
    email,
    password,
    name: name.trim() || undefined,
    companyName: company.trim() || undefined,
    token: token || undefined,
  };
  const currentRef = useRef(current);
  currentRef.current = current;
  const inFlightRef = useRef(false);

  // NOTE: Drop the token from the URL once captured so it does not linger in
  // history or leak via the Referer header. The field keeps the captured value.
  useEffect(() => {
    if (searchParams.has("token")) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // NOTE: The `!setupRequired` bounce is owned by SetupGate so this page can
  // stay focused on the form. Keep the signed-in guard for the brief window
  // between the auto-login state flip and navigate("/") below.
  if (user) return <Navigate to="/" replace />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlightRef.current) return;
    setError("");

    if (password !== confirmPassword) {
      setError(t("auth.passwordsNoMatch", "Passwords do not match"));
      return;
    }

    inFlightRef.current = true;
    setLoading(true);

    try {
      const sent = { ...current };
      const { data, error: apiError } = await api.api.auth.setup.post(sent);

      if (apiError) {
        // NOTE: 409 means setup was already completed (another replica, a
        // racing operator, or self-heal). Refresh `/auth/me` so the
        // SetupRequired flag flips false, then send the user to /login
        // instead of dead-ending on an error string. The status is cast
        // because Eden narrows the inferred error-status union to the
        // validation error (422) when no `response` schema is declared.
        if ((apiError.status as number) === 409) {
          await refresh();
          navigate("/login", { replace: true });
          return;
        }
        setError(
          refusal.capture(
            apiError,
            t("setup.failed", "Setup failed"),
            sent,
            currentRef.current,
          ) ?? "",
        );
        return;
      }

      refusal.clear();
      if (data?.user) {
        // NOTE: Seed the active-tenant selector synchronously from the just-created tenant BEFORE
        // login()/navigate, so the SUPER_ADMIN's first dashboard paint targets a real tenant
        // instead of racing the async /me refresh into an empty state.
        if (data.defaultTenantId) setActiveTenantId(data.defaultTenantId);
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
          <div className="mb-2 text-center">
            <h1 className="font-semibold text-2xl text-text-primary">
              {t("setup.title", "Create the admin account")}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                "setup.subtitle",
                "This is the first run. Create the initial administrator account to finish setup.",
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
              htmlFor="company"
              className="mb-1 block font-medium text-sm text-text-primary"
            >
              {t("setup.companyLabel", "Company name")}
            </label>
            <Input
              id="company"
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              disabled={loading}
              placeholder={t("setup.companyPlaceholder", "Your company")}
              error={!!refusal.at("companyName", current.companyName)}
              errorMessage={
                refusal.at("companyName", current.companyName) ?? undefined
              }
              helperText={t(
                "setup.companyHint",
                "Names your workspace. You can change it later.",
              )}
            />
          </div>

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
              disabled={loading}
              placeholder={t("auth.emailPlaceholder", "you@example.com")}
              error={!!refusal.at("email", current.email)}
              errorMessage={refusal.at("email", current.email) ?? undefined}
            />
          </div>

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
              placeholder={t("setup.namePlaceholder", "Optional")}
              error={!!refusal.at("name", current.name)}
              errorMessage={refusal.at("name", current.name) ?? undefined}
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
              error={!!refusal.at("password", current.password)}
              errorMessage={
                refusal.at("password", current.password) ?? undefined
              }
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

          {setupTokenRequired && (
            <div>
              <label
                htmlFor="token"
                className="mb-1 block font-medium text-sm text-text-primary"
              >
                {t("setup.tokenLabel", "Setup token")}
              </label>
              <Input
                id="token"
                type="password"
                showPasswordToggle
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                disabled={loading}
                error={!!refusal.at("token", current.token)}
                errorMessage={refusal.at("token", current.token) ?? undefined}
                helperText={t(
                  "setup.tokenHint",
                  "Printed in the server log on first start.",
                )}
              />
            </div>
          )}

          <Button
            type="submit"
            loading={loading}
            disabled={loading}
            className="w-full"
          >
            {loading
              ? t("setup.submitting", "Creating account...")
              : t("setup.submit", "Create admin account")}
          </Button>
        </form>

        <BrandFooter />
      </div>
    </div>
  );
}
