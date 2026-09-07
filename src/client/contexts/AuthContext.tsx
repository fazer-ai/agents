import { Loader2 } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { Logo } from "@/client/components/Logo";
import {
  getActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { forgetToolSamples } from "@/client/lib/toolSample";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  // NOTE: null only for SUPER_ADMIN (cross-tenant). Used by the UI to scope per-tenant
  // concerns (branding, realtime topic).
  tenantId: string | null;
  // The tenant's display name (header chip). Only /auth/me returns it; login/signup/accept
  // responses omit it (optional here), and login() backfills it via a /me refresh. Null for
  // SUPER_ADMIN, who sees the SELECTED tenant's name via the header switcher instead.
  tenantName?: string | null;
  // Whether the account has a local password (false for Google-only users). Only /auth/me returns
  // it; drives the settings change-password form vs the "you sign in with Google" note. Optional
  // because login/signup/accept responses omit it (backfilled by the /me refresh).
  hasPassword?: boolean;
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
  login: (user: User) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [providers, setProviders] = useState<AuthProviders>({});
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupTokenRequired, setSetupTokenRequired] = useState(false);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [mcpStdioEnabled, setMcpStdioEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  // THE ONE TRANSITION TO UNAUTHENTICATED, and everything that ends a session goes through it: the
  // explicit logout below, a 401 on any request, and the socket's auth-loss close, the last two via
  // the `auth:unauthorized` event. The tool editor keeps the last saved sample response in memory
  // (`client/lib/toolSample`), which is the customer's data; left behind, the next sign-in on this
  // same tab would be offered the previous operator's responses (round 4 of review).
  const clearUser = useCallback(() => {
    setUser(null);
    forgetToolSamples();
  }, []);

  // NOTE: Shared /me fetch used at boot and for explicit refreshes (e.g. after
  // a /setup 409, where the server flipped to "setup complete" but this client
  // still has the stale `setupRequired=true` and would otherwise loop through
  // SetupGate). Returns `true` when the server gave a definitive answer (a 200
  // with body, or a 4xx) and `false` on a transient failure (network error or
  // 5xx) so the boot path can retry instead of treating it as "logged out".
  const fetchAuthState = useCallback(async () => {
    try {
      const { data, error } = await api.api.auth.me.get();
      if (data && !error) {
        // NOTE: `setUser(data.user ?? null)` (not the prior conditional
        // `if (data.user)`) so a refresh() that observes a logged-out server
        // state clears any stale signed-in client state. The boot path is
        // unaffected (user defaults to null), but refresh() relies on this.
        setUser(data.user ?? null);
        // NOTE: Seed the SUPER_ADMIN's active-tenant selector on first login/reload so the console
        // opens on a real tenant instead of an empty dashboard. Only fill a NULL selection (never
        // override a deliberate switch). `defaultTenantId` is the first accessible tenant (the one
        // created at /setup on a fresh install); non-super users ignore the selector entirely.
        if (
          data.user?.role === "SUPER_ADMIN" &&
          data.defaultTenantId &&
          getActiveTenantId() === null
        ) {
          setActiveTenantId(data.defaultTenantId);
        }
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
        return true;
      }
      // NOTE: Eden types `error` as `null` for /me (the route declares no
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
  }, []);

  const refresh = useCallback(async () => {
    await fetchAuthState();
  }, [fetchAuthState]);

  useEffect(() => {
    let cancelled = false;

    // NOTE: The server is briefly unreachable during `bun dev --hot` reloads
    // and during transient network blips in production. The prior code treated
    // any failed /me at boot as "logged out", so a refresh landing in that
    // window sporadically redirected to /login (via ProtectedRoute) even though
    // the auth cookie was still valid. Retry network/5xx with a short backoff
    // (~4.5s worst case); only a 200 (session resolved, user or null) or a 4xx
    // ends the check. On the happy path the first attempt resolves instantly.
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
    // NOTE: A SUPER_ADMIN (tenantId null) with no active tenant selected yet would let the dashboard
    // mount and fire tenant-scoped calls (agents, metrics, approvals) with no X-Tenant-Id BEFORE the
    // async /me refresh seeds the selector → 400 on first paint. The boot/reload path avoids this by
    // awaiting /me before clearing `loading`; /setup avoids it by seeding the tenant synchronously from
    // its response. A fresh login has neither, so re-gate on `loading` until /me resolves (and seeds the
    // tenant). Non-super users, and browsers that already hold a stored selection, skip the wait.
    const awaitsTenantSeed =
      loggedInUser.role === "SUPER_ADMIN" && getActiveTenantId() === null;
    setUser(loggedInUser);
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

  const logout = async () => {
    try {
      await api.api.auth.logout.post();
    } catch {
      console.error("Logout failed");
    } finally {
      // In the `finally`, and through `clearUser`: a logout whose request failed is still a logout
      // as far as the person in front of the screen is concerned, and the clearing this owes is the
      // same one every other way of losing the session owes.
      clearUser();
    }
  };

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
        login,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
