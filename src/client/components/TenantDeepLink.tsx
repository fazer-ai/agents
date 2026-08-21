import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { useToast } from "@/client/components/Toast";
import { useAuth } from "@/client/contexts/AuthContext";
import {
  getActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { tenantDeepLinkAction } from "@/client/lib/tenantDeepLink";
import { suppressUnloadPrompt } from "@/client/lib/unsavedGuard";
import { SWITCH_TENANT_PARAM } from "@/modules/mcp/console-links";

// Applies the `?switchTenant=<id>` a console link carries (`src/modules/mcp/console-links.ts`).
// Wraps the app shell, so it covers every deeplink and not just the vault's.
//
// It reproduces the header switcher's mechanics deliberately: persist the selection, then a FULL
// reload, which is the single TOCTOU-safe source of truth for a tenant switch (header, AuthContext,
// branding and every cache are rebuilt, with no in-flight request capturing the old tenant). The
// decision itself is `tenantDeepLinkAction`, with a decision table of its own.
//
// It is a GATE and not a passive effect, which is the part that is easy to get wrong: the page under
// it would otherwise mount and fetch while the switch is still being decided, so the operator could
// be looking at tenant A's vault, with its buttons live, on a URL that already names tenant B. What
// it holds back is only the render, and only while a switch is actually in play: a page carrying no
// such parameter never waits for anything.
//
// The parameter is left ON the URL through the switch. After the reload the stored selection equals
// the requested one, the action becomes "none", and only then is it cleaned up. Consuming it before
// the reload would lose the switch on the way.
export function TenantDeepLink({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get(SWITCH_TENANT_PARAM);
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const [accessible, setAccessible] = useState<string[] | null>(null);
  // Set once the miss has been reported, so a re-render does not repeat the toast.
  const [reported, setReported] = useState(false);

  const action = tenantDeepLinkAction({
    requested,
    active: getActiveTenantId(),
    accessible,
    isSuperAdmin,
  });

  useEffect(() => {
    if (!requested || !isSuperAdmin) return;
    let on = true;
    api.api.v1.tenants
      .get()
      .then(({ data, error }) => {
        if (!on) return;
        // NOTE: a failed fetch resolves to the empty list rather than staying null, so a tenant we
        // could not verify is REPORTED instead of silently switched to, and the gate below opens.
        setAccessible(error || !data ? [] : data.tenants.map((tn) => tn.id));
      })
      .catch(() => {
        if (on) setAccessible([]);
      });
    return () => {
      on = false;
    };
  }, [requested, isSuperAdmin]);

  useEffect(() => {
    if (action.kind === "switch") {
      suppressUnloadPrompt();
      setActiveTenantId(action.tenantId);
      window.location.reload();
      return;
    }
    if (action.kind === "pending") return;
    if (action.kind === "unavailable") {
      if (!reported) {
        setReported(true);
        showToast(
          t(
            "tenant.deepLinkUnavailable",
            "This link points at a tenant you cannot open. Nothing was switched.",
          ),
          "error",
        );
      }
      return;
    }
    if (!requested) return;
    // Nothing left to do with it: drop it so a back-nav does not re-decide, and so the operator can
    // copy the URL without carrying a tenant into someone else's browser.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(SWITCH_TENANT_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [action, requested, reported, setSearchParams, showToast, t]);

  // Hold the render only while the answer could still be "you are on the wrong tenant". An
  // unavailable target opens the gate: the console stays where it is, and the toast says why.
  if (action.kind === "pending" || action.kind === "switch") {
    return (
      <div
        className="flex min-h-dvh items-center justify-center bg-bg-primary"
        role="status"
      >
        <span className="sr-only">{t("common.loading", "Loading…")}</span>
        <Loader2
          className="h-6 w-6 animate-spin text-text-secondary"
          aria-hidden
        />
      </div>
    );
  }
  return <>{children}</>;
}
