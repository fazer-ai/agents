import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Navigate, useLocation } from "react-router";
import { Layout } from "@/client/components/Layout";
import { TenantDeepLink } from "@/client/components/TenantDeepLink";
import { useAuth } from "@/client/contexts/AuthContext";
import { isAdminRole } from "@/client/lib/roles";
import { SWITCH_TENANT_PARAM } from "@/lib/console-params";

interface ProtectedRouteProps {
  children: ReactNode;
  requireAdmin?: boolean;
}

export function ProtectedRoute({
  children,
  requireAdmin = false,
}: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg-primary">
        <Loader2 className="h-6 w-6 animate-spin text-text-secondary" />
      </div>
    );
  }

  if (!user) {
    const redirectTo = location.pathname + location.search;
    const loginUrl =
      redirectTo !== "/"
        ? `/login?redirect=${encodeURIComponent(redirectTo)}`
        : "/login";
    return <Navigate to={loginUrl} replace />;
  }

  // Non-admins (AGENT) have no dashboard; "/" is the dashboard, so bounce them to their
  // primary surface instead of looping back to "/". The role read here is the one held in the ACTIVE
  // tenant, so a link to another tenant where the person IS an administrator goes through to the
  // switch below, and meets this gate again after the reload with the role held there (issue #756,
  // review round 2).
  if (requireAdmin && !isAdminRole(user.role)) {
    const requested = new URLSearchParams(location.search).get(
      SWITCH_TENANT_PARAM,
    );
    // A fresh login answers with the DEFAULT membership's role and no membership list; `/auth/me`
    // brings the role held in the selected tenant, and the list, a moment later. Deciding before it
    // lands would send an administrator of the selected or linked tenant away and lose the page they
    // asked for (review rounds 3 and 6).
    if (user.tenants === undefined) {
      return <SessionPending />;
    }
    if (!switchesToAdministeredTenant(requested, user)) {
      return <Navigate to="/conversations" replace />;
    }
  }

  // A console link can name the tenant it belongs to. Applying that is the app shell's job, not any
  // one page's, and it WRAPS the content rather than sitting beside it: a page that mounts while the
  // switch is still being decided fetches the tenant the console is about to leave (see
  // TenantDeepLink).
  return (
    <TenantDeepLink>
      <Layout>{children}</Layout>
    </TenantDeepLink>
  );
}

function switchesToAdministeredTenant(
  requested: string | null,
  user: { tenantId: string | null; tenants?: { id: string; role: string }[] },
): boolean {
  if (!requested || requested === user.tenantId) return false;
  return (user.tenants ?? []).some(
    (m) => m.id === requested && isAdminRole(m.role),
  );
}

// How often the wait below asks `/auth/me` again. Exported for the test.
export const SESSION_RETRY_MS = 2_000;

// The wait for `/auth/me` after a fresh login. The login's own refresh is ONE attempt, so a blip there
// would otherwise leave this spinner up for good (review round 7): it asks again until the session
// arrives, and unmounts as soon as it does (or sends the visitor to /login if the answer is "signed
// out", through the `!user` branch above).
function SessionPending() {
  const { refresh } = useAuth();
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
    }, SESSION_RETRY_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-primary">
      <Loader2 className="h-6 w-6 animate-spin text-text-secondary" />
    </div>
  );
}
