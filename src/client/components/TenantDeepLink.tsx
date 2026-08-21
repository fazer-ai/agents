import { useEffect, useRef, useState } from "react";
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

// Applies the `?tenant=<id>` a console link carries (`src/modules/mcp/console-links.ts`). Mounted
// once inside the app shell, so it covers every deeplink and not just the vault's.
//
// It reproduces the header switcher's mechanics deliberately: persist the selection, then a FULL
// reload, which is the single TOCTOU-safe source of truth for a tenant switch (header, AuthContext,
// branding and every cache are rebuilt, with no in-flight request capturing the old tenant). The
// decision itself is `tenantDeepLinkAction`, with a decision table of its own.
//
// The parameter is left ON the URL through the switch: after the reload the stored selection equals
// the requested one, the action becomes "none", and only then is it cleaned up. Consuming it before
// the reload would lose the switch on the way.
export function TenantDeepLink() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tenant");
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const [accessible, setAccessible] = useState<string[] | null>(null);
  // One decision per requested tenant: switching reloads, and a repeat on the same value would be
  // the loop.
  const decided = useRef<string | null>(null);

  useEffect(() => {
    if (!requested || !isSuperAdmin) return;
    let on = true;
    api.api.v1.tenants
      .get()
      .then(({ data, error }) => {
        if (!on) return;
        // NOTE: a failed fetch resolves to the empty list rather than staying null, so a tenant we
        // could not verify is REPORTED instead of silently switched to.
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
    if (!requested) return;
    const action = tenantDeepLinkAction({
      requested,
      active: getActiveTenantId(),
      accessible,
      isSuperAdmin,
    });
    if (action.kind === "switch") {
      // NOTE: the parameter is deliberately left on the URL across the reload. After it, the stored
      // selection equals the requested one, the action becomes "none", and the cleanup below runs.
      // Consuming it first would lose the switch on the way.
      suppressUnloadPrompt();
      setActiveTenantId(action.tenantId);
      window.location.reload();
      return;
    }
    if (decided.current === requested) return;
    decided.current = requested;
    if (action.kind === "unavailable") {
      showToast(
        t(
          "tenant.deepLinkUnavailable",
          "This link points at a tenant you cannot open. Nothing was switched.",
        ),
        "error",
      );
      return;
    }
    // Nothing left to do with it: drop it so a back-nav does not re-decide, and so the operator can
    // copy the URL without carrying a tenant into someone else's browser.
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("tenant");
        return next;
      },
      { replace: true },
    );
  }, [requested, accessible, isSuperAdmin, setSearchParams, showToast, t]);

  return null;
}
