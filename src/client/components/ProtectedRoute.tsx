import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { Layout } from "@/client/components/Layout";
import { TenantDeepLink } from "@/client/components/TenantDeepLink";
import { useAuth } from "@/client/contexts/AuthContext";
import { type ClientRole, roleAtLeast } from "@/client/lib/roles";
import { useSessionRetry } from "@/client/lib/useSessionRetry";
import { SWITCH_TENANT_PARAM } from "@/lib/console-params";

interface ProtectedRouteProps {
  children: ReactNode;
  requireAdmin?: boolean;
  requireRole?: ClientRole;
  // Without the console's sidebar and header: a dashboard's TV mode fills the screen on its own.
  bare?: boolean;
}

export function ProtectedRoute({
  children,
  requireAdmin = false,
  requireRole,
  bare = false,
}: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="bg-bg-primary flex min-h-dvh items-center justify-center">
        <Loader2 className="text-text-secondary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!user) {
    const redirectTo = location.pathname + location.search + location.hash;
    const loginUrl =
      redirectTo !== "/"
        ? `/login?redirect=${encodeURIComponent(redirectTo)}`
        : "/login";
    return <Navigate to={loginUrl} replace />;
  }

  // The minimum rank keeps a restricted member off surfaces their active membership cannot reach.
  // A link to another tenant is allowed through only when that membership also meets this rank; the
  // gate runs again after the tenant switch reloads the session.
  const minimumRole =
    requireRole ?? (requireAdmin ? "TENANT_ADMIN" : undefined);
  if (minimumRole && !roleAtLeast(user.role, minimumRole)) {
    const requested = new URLSearchParams(location.search).get(
      SWITCH_TENANT_PARAM,
    );
    // NOTE: a fresh login answers with the DEFAULT membership's role and no membership list; `/auth/me`
    // brings the role held in the selected tenant, and the list, a moment later. Deciding before it
    // lands would send an administrator of the selected or linked tenant away from the page they asked for.
    if (user.tenants === undefined) {
      return <SessionPending />;
    }
    if (!switchesToAllowedTenant(requested, user, minimumRole)) {
      return <Navigate to="/conversations" replace />;
    }
  }

  // A console link can name the tenant it belongs to. Applying that is the app shell's job, not any
  // one page's, and it WRAPS the content rather than sitting beside it: a page that mounts while the
  // switch is still being decided fetches the tenant the console is about to leave (see
  // TenantDeepLink).
  return (
    <TenantDeepLink>
      {bare ? children : <Layout>{children}</Layout>}
    </TenantDeepLink>
  );
}

function switchesToAllowedTenant(
  requested: string | null,
  user: { tenantId: string | null; tenants?: { id: string; role: string }[] },
  minimumRole: ClientRole,
): boolean {
  if (!requested || requested === user.tenantId) return false;
  return (user.tenants ?? []).some(
    (m) => m.id === requested && roleAtLeast(m.role, minimumRole),
  );
}

// The wait for `/auth/me` after a fresh login, asking again until the session arrives
// (`useSessionRetry`). It unmounts as soon as it does, or sends the visitor to /login through the
// `!user` branch above if the answer is "signed out".
function SessionPending() {
  useSessionRetry(true);
  return (
    <div className="bg-bg-primary flex min-h-dvh items-center justify-center">
      <Loader2 className="text-text-secondary h-6 w-6 animate-spin" />
    </div>
  );
}
