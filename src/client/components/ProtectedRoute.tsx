import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { Layout } from "@/client/components/Layout";
import { TenantDeepLink } from "@/client/components/TenantDeepLink";
import { useAuth } from "@/client/contexts/AuthContext";
import { isAdminRole } from "@/client/lib/roles";

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
  // primary surface instead of looping back to "/".
  if (requireAdmin && !isAdminRole(user.role)) {
    return <Navigate to="/conversations" replace />;
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
