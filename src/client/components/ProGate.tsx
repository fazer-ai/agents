import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import {
  Modal,
  type ModalController,
  useModalController,
} from "@/client/components/Modal";
import { IS_FREE } from "@/client/lib/env";
import { UPGRADE_URL } from "@/client/lib/navigation";

// A feature that is available on the Pro edition only. Extend the union + the description map to
// gate a new feature; the modal title/CTA are shared.
export type ProFeature = "multiTenant" | "branding";

// Per-feature body copy. The modal title and CTA are generic; only the description names the
// feature. Keys are declared with magic comments so `bun i18n:extract` picks them up despite the
// dynamic lookup below.
// t('upgrade.multiTenant.description', 'The Free edition runs a single tenant. Upgrade to Pro to create and manage multiple tenants.')
// t('upgrade.branding.description', 'White-label branding (name, colors, logo, favicon) is a Pro feature. Upgrade to Pro to customize the app identity.')
const FEATURE_DESCRIPTION_KEY: Record<ProFeature, string> = {
  multiTenant: "upgrade.multiTenant.description",
  branding: "upgrade.branding.description",
};

// Upsell affordance for a Pro-only action, shown ONLY in the Free edition. Renders its own trigger
// (the "isca" button that stands in for the real action) and owns an upgrade modal that links to
// app.fazer.ai. Outside the Free edition it renders nothing. Reusable: pass `feature` for the copy and
// optionally `triggerLabel`/`trigger` to match the action it replaces.
export function ProGate({
  feature,
  triggerLabel,
  trigger,
  size = "sm",
  controller,
}: {
  feature: ProFeature;
  triggerLabel?: string;
  // Full control over the trigger element; receives the opener. Defaults to a primary button.
  trigger?: (open: () => void) => ReactNode;
  size?: "sm" | "md";
  // When set, the CALLER owns the trigger and opens the upgrade modal via this controller; ProGate
  // then renders only the modal. Use when the trigger must live outside a container that unmounts on
  // interaction (e.g. a Radix dropdown item, whose menu closes on select and would take an inline
  // modal down with it). Without it, ProGate renders its own trigger + controller.
  controller?: ModalController;
}) {
  const { t } = useTranslation();
  const ownModal = useModalController();
  const modal = controller ?? ownModal;
  // Renders only in the Free edition. Callers already gate on IS_FREE, so this guard is defense in
  // depth (and must sit ABOVE the Modal so the always-rendered-Modal rule is not violated when it
  // does render).
  if (!IS_FREE) return null;

  const descriptionKey = FEATURE_DESCRIPTION_KEY[feature];

  // With a controller the caller renders its own trigger (ProGate owns only the modal); otherwise
  // render the caller's custom trigger, or the default upgrade button.
  let triggerNode: ReactNode = null;
  if (!controller) {
    triggerNode = trigger ? (
      trigger(modal.open)
    ) : (
      <Button size={size} onClick={modal.open}>
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        {triggerLabel ?? t("upgrade.title", "Pro feature")}
      </Button>
    );
  }

  return (
    <>
      {triggerNode}
      <Modal modal={modal} title={t("upgrade.title", "Pro feature")} size="sm">
        <div className="space-y-5">
          <p className="text-sm text-text-secondary">
            {
              // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in FEATURE_DESCRIPTION_KEY
              t(descriptionKey, "This feature is available on the Pro edition.")
            }
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={modal.close}>
              {t("upgrade.dismiss", "Maybe later")}
            </Button>
            <a
              href={UPGRADE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-accent-solid px-4 py-2 font-medium text-accent-foreground text-sm transition-colors hover:bg-accent-solid-hover"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              {t("upgrade.cta", "Upgrade to Pro")}
            </a>
          </div>
        </div>
      </Modal>
    </>
  );
}
