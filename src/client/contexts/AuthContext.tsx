import { Loader2 } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Logo } from "@/client/components/Logo";
import {
  adoptSessionTenant,
  getActiveTenantId,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { applyUserUpdate } from "@/client/lib/applyUserUpdate";
import { performLogout } from "@/client/lib/logout";
import { noteOperator } from "@/client/lib/toolSample";
import type { TtsCheckMode } from "@/modules/tts/settings-shared";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  // Null only for SUPER_ADMIN (cross-tenant). Used by the UI to scope per-tenant concerns (branding,
  // realtime topic). For everyone else it is the tenant THIS session runs under: the membership the
  // console selected, or the person's default.
  tenantId: string | null;
  // The tenant's display name (header chip). Only /auth/me returns it; login/signup/accept
  // responses omit it (optional here), and login() backfills it via a /me refresh. Null for
  // SUPER_ADMIN, who sees the SELECTED tenant's name via the header switcher instead.
  tenantName?: string | null;
  // Whether the account has a local password (false for Google-only users). Only /auth/me returns
  // it; drives the settings change-password form vs the "you sign in with Google" note. Optional
  // because login/signup/accept responses omit it (backfilled by the /me refresh).
  hasPassword?: boolean;
  // Whether the account is linked to a Google identity, and when it was created. Only /auth/me
  // returns them (the Settings pages read them), backfilled by the /me refresh after a login.
  googleLinked?: boolean;
  createdAt?: string | null;
  // Every tenant the person belongs to, with the role held there. Only /auth/me returns it; more than
  // one puts the membership switcher in the header. Empty for the SUPER_ADMIN.
  tenants?: { id: string; name: string; role: string }[];
}

export interface GoogleAuthProvider {
  clientId: string;
}

export interface AuthProviders {
  google?: GoogleAuthProvider;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  providers: AuthProviders;
  setupRequired: boolean;
  setupTokenRequired: boolean;
  signupEnabled: boolean;
  mcpStdioEnabled: boolean;
  // The deployment's audio detector, as far as the editor needs it.
  ttsCheck: { configured: boolean; mode: TtsCheckMode };
  login: (user: User) => void;
  logout: () => Promise<boolean>;
  refresh: () => Promise<void>;
  // Applies fields a mutation already returned (PATCH /auth/me), so a save does not depend on a
  // follow-up refresh. Keyed by the account that made the change: a response landing after a
  // sign-out and a sign-in as someone else must not rename the new account.
  updateUser: (userId: string, fields: Partial<User>) => void;
}

// Exported so a test can hand a component what /me would have said without the whole provider.
export const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [providers, setProviders] = useState<AuthProviders>({});
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupTokenRequired, setSetupTokenRequired] = useState(false);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [mcpStdioEnabled, setMcpStdioEnabled] = useState(false);
  const [ttsCheck, setTtsCheck] = useState<{
    configured: boolean;
    mode: TtsCheckMode;
  }>({ configured: false, mode: "off" });
  const [loading, setLoading] = useState(true);
  // Bumped on every sign-in and sign-out. A /me response that left under an earlier session must not
  // touch the current one: a refresh resolving after a sign-out would otherwise bring the
  // signed-out user back.
  const sessionGen = useRef(0);
  // The user as last applied, for `updateUser`, which merges into it without a second setter. Written
  // only in `applyUser`, not per render: a sign-out and a late save landing in one batch must see the
  // sign-out, and the render in between is exactly what has not happened yet.
  const userRef = useRef<User | null>(null);

  // THE ONLY CALLER OF `setUser`, so what has to happen on every transition to unauthenticated
  // is written once, where the transition IS. The tool editor keeps the last sample response in memory
  // (`client/lib/toolSample`), the customer's data, which the next sign-in on this tab must not be
  // offered. The paths that end a session are the explicit logout below, a 401 on any request and the
  // socket's auth-loss close (both via `auth:unauthorized`), and a `/me` answering a null user, which
  // is how a refresh observes a session the server already ended.

  const applyUser = useCallback((next: User | null) => {
    userRef.current = next;
    setUser(next);
    // UNCONDITIONAL, and the comparison is the module's: what it owns is whose captured responses it
    // is holding, and every transition this console makes is one it has to hear about. That includes
    // A CHANGING TO B with no null in between, which is what a shared cookie produces when another
    // tab signs out and back in. What this can answer for is every transition that goes through
    // here, which is every one this context makes; a tab that never refreshes its auth is still
    // rendering A entirely, and that is not this module's to fix.
    noteOperator(next?.id ?? null);
  }, []);

  const clearUser = useCallback(() => {
    sessionGen.current += 1;
    applyUser(null);
  }, [applyUser]);

  // Shared /me fetch used at boot and for explicit refreshes (e.g. after
  // a /setup 409, where the server flipped to "setup complete" but this client
  // still has the stale `setupRequired=true` and would otherwise loop through
  // SetupGate). Returns `true` when the server gave a definitive answer (a 200
  // with body, or a 4xx) and `false` on a transient failure (network error or
  // 5xx) so the boot path can retry instead of treating it as "logged out".
  const fetchAuthState = useCallback(async () => {
    const genAtStart = sessionGen.current;
    try {
      const { data, error } = await api.api.auth.me.get();
      if (sessionGen.current !== genAtStart) return true;
      if (data && !error) {
        // NOTE: applied even when null, so a refresh() that observes a logged-out server clears any stale
        // signed-in client state. The boot path is unaffected (user defaults to null).
        applyUser(data.user ?? null);
        adoptSessionTenant(data.user ?? null, data.defaultTenantId ?? null);
        const next: AuthProviders = {};
        if (
          data.providers &&
          typeof data.providers === "object" &&
          "google" in data.providers &&
          data.providers.google &&
          typeof data.providers.google === "object" &&
          "clientId" in data.providers.google &&
          typeof data.providers.google.clientId === "string"
        ) {
          next.google = { clientId: data.providers.google.clientId };
        }
        setProviders(next);
        if (typeof data.setupRequired === "boolean")
          setSetupRequired(data.setupRequired);
        if (typeof data.setupTokenRequired === "boolean")
          setSetupTokenRequired(data.setupTokenRequired);
        if (typeof data.signupEnabled === "boolean")
          setSignupEnabled(data.signupEnabled);
        if (typeof data.mcpStdioEnabled === "boolean")
          setMcpStdioEnabled(data.mcpStdioEnabled);
        if (data.ttsCheck) setTtsCheck(data.ttsCheck);
        return true;
      }
      // Eden types `error` as `null` for /me (the route declares no
      // non-2xx responses), but the framework still surfaces a real error
      // object on a 5xx or network failure at runtime, hence the cast. A 4xx is
      // a definitive client-side answer (stop); 5xx/unknown is transient.
      const status = (error as { status?: number } | null)?.status ?? 0;
      return status >= 400 && status < 500;
    } catch (error) {
      // NOTE: Network/transient failure (server mid-restart during
      // `bun dev --hot`, or a blip during 24/7 operation), not a "logged out"
      // signal. Report it as non-definitive so the boot path retries.
      console.warn("Failed to load auth state (transient)", error);
      return false;
    }
  }, [applyUser]);

  const refresh = useCallback(async () => {
    await fetchAuthState();
  }, [fetchAuthState]);

  const updateUser = useCallback(
    (userId: string, fields: Partial<User>) =>
      applyUser(applyUserUpdate(userRef.current, userId, fields)),
    [applyUser],
  );

  useEffect(() => {
    let cancelled = false;

    // The server is briefly unreachable during `bun dev --hot` reloads and network blips in
    // production, and treating a failed /me at boot as "logged out" would redirect to /login (via
    // ProtectedRoute) with the auth cookie still valid. So network/5xx retries with a short backoff
    // (~4.5s worst case); only a 200 (user or null) or a 4xx ends the check.
    const resolveAuth = async () => {
      const backoffMs = [300, 600, 1200, 2400];
      for (let attempt = 0; ; attempt++) {
        const resolved = await fetchAuthState();
        if (cancelled) return;
        if (resolved || attempt >= backoffMs.length) break;
        await new Promise((settle) => setTimeout(settle, backoffMs[attempt]));
      }
      if (!cancelled) setLoading(false);
    };

    void resolveAuth();
    return () => {
      cancelled = true;
    };
  }, [fetchAuthState]);

  useEffect(() => {
    window.addEventListener("auth:unauthorized", clearUser);
    return () => window.removeEventListener("auth:unauthorized", clearUser);
  }, [clearUser]);

  const login = (loggedInUser: User) => {
    // A SUPER_ADMIN (tenantId null) with no active tenant selected yet would let the dashboard
    // mount and fire tenant-scoped calls (agents, metrics, approvals) with no X-Tenant-Id BEFORE the
    // async /me refresh seeds the selector → 400 on first paint. The boot/reload path avoids this by
    // awaiting /me before clearing `loading`; /setup avoids it by seeding the tenant synchronously from
    // its response. A fresh login has neither, so re-gate on `loading` until /me resolves (and seeds the
    // tenant). Non-super users, and browsers that already hold a stored selection, skip the wait.
    const awaitsTenantSeed =
      loggedInUser.role === "SUPER_ADMIN" && getActiveTenantId() === null;
    sessionGen.current += 1;
    applyUser(loggedInUser);
    // NOTE: A successful auth means at least one account exists, so first-run
    // setup is necessarily done. Clear the (boot-time) flag so SetupGate stops
    // redirecting to /setup, avoiding a redirect loop right after /setup.
    setSetupRequired(false);
    // Login/signup/accept responses omit tenantName; backfill the complete user (incl. the header
    // tenant name) from /me. For a SUPER_ADMIN without a stored tenant, hold the loader until that
    // refresh lands so the selector is seeded before the dashboard's first tenant-scoped fetch.
    if (awaitsTenantSeed) {
      setLoading(true);
      void fetchAuthState().finally(() => setLoading(false));
    } else {
      void fetchAuthState();
    }
  };

  const logout = () =>
    performLogout(() => api.api.auth.logout.post(), clearUser);

  if (loading) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-primary">
        <Logo className="h-10" />
        <Loader2 className="h-6 w-6 animate-spin text-text-secondary" />
      </div>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        providers,
        setupRequired,
        setupTokenRequired,
        signupEnabled,
        mcpStdioEnabled,
        ttsCheck,
        login,
        logout,
        refresh,
        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// The deployment's audio detector, read without requiring a provider: the Behavior tab is also
// rendered on its own (tests, previews), and there "no detector" is the honest answer.
export function useTtsCheckInfo(): { configured: boolean; mode: TtsCheckMode } {
  return (
    useContext(AuthContext)?.ttsCheck ?? { configured: false, mode: "off" }
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
