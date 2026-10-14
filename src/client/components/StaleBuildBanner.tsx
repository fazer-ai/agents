import { RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { Button } from "@/client/components/Button";
import { useConfirmLeave } from "@/client/contexts/NavGuardContext";
import { api } from "@/client/lib/api";
import {
  getStaleBuild,
  reloadIntoServedBuild,
  useStaleBuild,
} from "@/client/lib/staleBuild";
import { hasUnsavedChanges } from "@/client/lib/unsavedGuard";

// A focus with no request behind it would leave a tab that sat idle through a deploy unaware of it,
// so focus asks the server once; the throttle keeps alt-tabbing from turning into a request each time.
const FOCUS_CHECK_INTERVAL_MS = 15_000;

// Mounted once inside the router. Asks the server on window focus, and when the operator moves to
// another screen with nothing unsaved reloads a tab the server has outgrown: they were leaving the
// screen anyway, so the reload costs nothing they would keep.
export function StaleBuildWatcher() {
  const location = useLocation();
  const lastCheck = useRef(0);
  const lastPath = useRef(location.pathname);

  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastCheck.current < FOCUS_CHECK_INTERVAL_MS) return;
      lastCheck.current = now;
      api.api.health.get().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // NOTE: the pathname is the screen. A filter, a search box or an anchor rewrites only the query or
  // the hash while the operator is still working on the same screen, mid-typing included.
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    if (getStaleBuild().stale && !hasUnsavedChanges()) window.location.reload();
  }, [location.pathname]);

  return null;
}

// Shown in the shell while this tab runs an older frontend than the server serves. Never reloads by
// itself, so a half-filled form stays where it is; the button goes through the same discard confirm
// as leaving the page.
export function StaleBuildBanner() {
  const { t } = useTranslation();
  const { stale, serverVersion } = useStaleBuild();
  const confirmLeave = useConfirmLeave();
  if (!stale) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-info border-b bg-info-soft px-4 py-2.5"
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-info" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-sm text-text-primary">
        {serverVersion
          ? t(
              "staleBuild.bannerVersion",
              "The console was updated to v{{version}}. Reload to use the new version.",
              { version: serverVersion },
            )
          : t(
              "staleBuild.banner",
              "The console was updated. Reload to use the new version.",
            )}
      </span>
      <Button size="sm" onClick={() => confirmLeave(reloadIntoServedBuild)}>
        {t("staleBuild.reload", "Reload")}
      </Button>
    </div>
  );
}
