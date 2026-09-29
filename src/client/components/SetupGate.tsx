import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "@/client/contexts/AuthContext";

// Funnels traffic to /setup while the instance has no users (so the first
// account is always created as ADMIN there), and bounces off /setup once setup
// is done. Auth data is already loaded when this renders (AuthProvider holds the
// splash until loading resolves), so the synchronous <Navigate> causes no
// flicker.
export function SetupGate({ children }: { children: ReactNode }) {
  const { setupRequired, user } = useAuth();
  const { pathname } = useLocation();

  // NOTE: Only force /setup when nobody is signed in. A logged-in user means an
  // account exists, so setup is moot; this also prevents a redirect loop right
  // after the setup auto-login, when setupRequired may still be stale.
  if (setupRequired && !user && pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }
  if (!setupRequired && pathname === "/setup") {
    // NOTE: An authenticated visit to /setup goes straight to "/"; bouncing
    // to /login would only have LoginPage redirect them on. Anonymous traffic
    // still lands on /login.
    return <Navigate to={user ? "/" : "/login"} replace />;
  }
  return <>{children}</>;
}
