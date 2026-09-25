import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Building2, Check, ChevronDown, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useModalController } from "@/client/components/Modal";
import { ProGate } from "@/client/components/ProGate";
import { useConfirmLeave } from "@/client/contexts/NavGuardContext";
import { useTenantList } from "@/client/hooks/useTenantList";
import { setActiveTenantId } from "@/client/lib/activeTenant";
import { IS_FREE } from "@/client/lib/env";
import { reloadOntoSafeRoute } from "@/client/lib/tenantSwitch";
import { cn } from "@/client/lib/utils";

// Dedicated target-tenant picker mounted in the header (NOT inside the user menu): the SUPER_ADMIN's
// over the whole fleet, and a person's over their memberships.
// Switching sets the persisted X-Tenant-Id and does a FULL reload — the simplest TOCTOU-safe
// switch (a single source of truth after reload: the header, AuthContext, branding and every
// cache are rebuilt for the new tenant, with no in-flight request capturing the old one).
const itemCls =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary";

export function TenantSwitcher() {
  // Mounted only for a SUPER_ADMIN (TenantIndicator), so the list is always this component's to read.
  const { tenants, activeId } = useTenantList(true);
  return <TenantPicker tenants={tenants} activeId={activeId} canCreate />;
}

// The same picker for a PERSON with several memberships (issue #756): their tenants come on the
// session (`/auth/me`), the active one is the tenant the session runs under, and there is nothing to
// create. Choosing one is the same persisted X-Tenant-Id and the same full reload.
export function MembershipSwitcher({
  tenants,
  activeId,
}: {
  tenants: { id: string; name: string }[];
  activeId: string | null;
}) {
  return (
    <TenantPicker tenants={tenants} activeId={activeId} canCreate={false} />
  );
}

function TenantPicker({
  tenants,
  activeId,
  canCreate,
}: {
  tenants: { id: string; name: string }[];
  activeId: string | null;
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirmLeave = useConfirmLeave();
  const upgrade = useModalController();
  const active = activeId ?? "";

  // The fallback label now only ever means what it says. A stored id the list does not have is
  // cleared by the hook, so "Select tenant" no longer doubles as the display for a dead selection.
  const activeName =
    tenants.find((tn) => tn.id === active)?.name ??
    t("tenant.select", "Select tenant");

  return (
    <>
      <DropdownMenuPrimitive.Root>
        <DropdownMenuPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={t("tenant.switcher", "Switch tenant")}
            className="group inline-flex max-w-50 items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary"
          >
            <Building2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="hidden truncate sm:inline">{activeName}</span>
            <ChevronDown
              aria-hidden="true"
              className="h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
            />
          </button>
        </DropdownMenuPrimitive.Trigger>

        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align="start"
            sideOffset={6}
            className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-(--z-dropdown) max-h-80 min-w-56 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-1 shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in"
          >
            <DropdownMenuPrimitive.Label className="px-2 py-1 font-medium text-text-muted text-xs uppercase">
              {t("tenant.label", "Tenant")}
            </DropdownMenuPrimitive.Label>
            {tenants.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-text-muted">
                {t("tenant.none", "No tenants yet.")}
              </p>
            ) : (
              <DropdownMenuPrimitive.RadioGroup
                value={active}
                onValueChange={(value) => {
                  // Re-selecting the active tenant is a no-op (avoid a needless full reload).
                  if (value === active) return;
                  // Switching reloads the whole app, so any unsaved page edits are
                  // lost — gate it behind the discard confirm and only persist +
                  // reload once approved. Persisting before the (cancelable) native
                  // prompt would otherwise leave the new tenant set while the UI
                  // stays put, surfacing the switch only on the next refresh.
                  confirmLeave(() => {
                    setActiveTenantId(value);
                    reloadOntoSafeRoute();
                  });
                }}
              >
                {tenants.map((tn) => {
                  const selected = tn.id === active;
                  return (
                    <DropdownMenuPrimitive.RadioItem
                      key={tn.id}
                      value={tn.id}
                      className={cn(itemCls, { "bg-bg-tertiary": selected })}
                    >
                      <span className="flex-1 truncate">{tn.name}</span>
                      {selected && (
                        <Check
                          className="ml-auto h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                    </DropdownMenuPrimitive.RadioItem>
                  );
                })}
              </DropdownMenuPrimitive.RadioGroup>
            )}
            {canCreate && (
              <>
                <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
                <DropdownMenuPrimitive.Item
                  className={cn(itemCls, "text-text-secondary")}
                  onSelect={() =>
                    // Free ships the same picker as Pro, but "create" opens the upgrade CTA instead of the
                    // create page. The modal is hosted at the component root (below), OUTSIDE this menu, so
                    // it survives the dropdown closing on select.
                    IS_FREE
                      ? upgrade.open()
                      : confirmLeave(() => navigate("/admin/tenants?create=1"))
                  }
                >
                  <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate">
                    {t("tenant.create", "Create tenant")}
                  </span>
                </DropdownMenuPrimitive.Item>
              </>
            )}
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
      {/* Free-only: hosts the upgrade modal opened by the "create" item above. Renders null in Pro. */}
      {canCreate && <ProGate feature="multiTenant" controller={upgrade} />}
    </>
  );
}
