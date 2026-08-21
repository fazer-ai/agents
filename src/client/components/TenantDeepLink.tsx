import { Loader2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button } from "@/client/components/Button";
import { EmptyState } from "@/client/components/EmptyState";
import { useToast } from "@/client/components/Toast";
import { useAuth } from "@/client/contexts/AuthContext";
import {
  getActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import {
  type TenantScope,
  tenantDeepLinkAction,
} from "@/client/lib/tenantDeepLink";
import { suppressUnloadPrompt } from "@/client/lib/unsavedGuard";
import { SWITCH_TENANT_PARAM } from "@/lib/console-params";

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
// be looking at tenant A's vault, with its buttons live, on a URL that already names tenant B.
//
// What opens the gate is knowing the answer, not liking it. `unavailable` opens it, because the
// console genuinely cannot go anywhere else and staying put is correct. `unverified` does NOT: there
// the answer is unknown, the page underneath is the tenant the link says is the wrong one, and
// showing it with its controls live is the exact failure the gate exists to prevent. It offers a
// retry instead, which is the only thing that can actually resolve the state.
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
  // A fleet session's tenant list: undefined = still loading, null = could not be read.
  const [accessible, setAccessible] = useState<string[] | null | undefined>(
    undefined,
  );
  // Only the newest read may write the answer. The retry makes out-of-order replies reachable: the
  // failure that opened the retry can land after the read the retry started, and would otherwise
  // overwrite a good list with a stale "could not read".
  const readId = useRef(0);
  // Set once the miss has been reported, so a re-render does not repeat the toast.
  const [reported, setReported] = useState(false);

  // A SUPER_ADMIN is fleet-level and carries no tenant of its own (`tenantId` is null for exactly
  // that role); anyone else is pinned to theirs. Falling back to "loading" while the session itself
  // is still resolving keeps the gate shut rather than guessing at a scope.
  const scope: TenantScope = !user
    ? { kind: "loading" }
    : isSuperAdmin
      ? accessible === undefined
        ? { kind: "loading" }
        : accessible === null
          ? { kind: "unknown" }
          : { kind: "fleet", accessible }
      : user.tenantId === null
        ? { kind: "unknown" }
        : { kind: "tenant", tenantId: user.tenantId };

  const action = tenantDeepLinkAction({
    requested,
    active: getActiveTenantId(),
    scope,
  });

  const readTenants = useCallback(() => {
    if (!requested || !isSuperAdmin) return;
    const id = ++readId.current;
    setAccessible(undefined);
    api.api.v1.tenants
      .get()
      .then(({ data, error }) => {
        if (id !== readId.current) return;
        // NOTE: a failed read becomes null, NOT the empty list. The empty list is the claim "you can
        // open no tenant", which would report this link as bad and open the gate on the tenant the
        // link says is the wrong one; null says only that we do not know.
        setAccessible(error || !data ? null : data.tenants.map((tn) => tn.id));
      })
      .catch(() => {
        if (id === readId.current) setAccessible(null);
      });
  }, [requested, isSuperAdmin]);

  useEffect(() => {
    readTenants();
  }, [readTenants]);

  useEffect(() => {
    if (action.kind === "switch") {
      suppressUnloadPrompt();
      setActiveTenantId(action.tenantId);
      window.location.reload();
      return;
    }
    if (action.kind === "pending" || action.kind === "unverified") return;
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

  if (action.kind === "unverified") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg-primary p-6">
        <EmptyState
          title={t("tenant.deepLinkUnverified", "Could not check this link")}
          description={t(
            "tenant.deepLinkUnverifiedHelp",
            "This link opens a different tenant, and the list of tenants you can open could not be read. Nothing was switched.",
          )}
          action={
            <Button onClick={readTenants} variant="secondary">
              {t("common.retry", "Retry")}
            </Button>
          }
        />
      </div>
    );
  }

  // Hold the render while the answer could still be "you are on the wrong tenant".
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
