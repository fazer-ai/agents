import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { ProGate } from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";

// Branding tab in the Free edition: white-label customization (name, colors, logo, favicon) is a Pro
// feature, so the editor is replaced by an upgrade gate. The app still renders the default fazer.ai
// identity, served by the public GET /v1/branding.

export function AdminBrandingPage() {
  const { t } = useTranslation();
  const { user } = useAuth();

  // Identity is fleet-global; a tenant admin has no business here.
  if (user && user.role !== "SUPER_ADMIN") {
    return <Navigate to="/admin/users" replace />;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <Palette className="h-6 w-6 text-accent" aria-hidden="true" />
        <div>
          <h2 className="font-semibold text-text-primary text-xl">
            {t("branding.title", "Branding")}
          </h2>
          <p className="mt-0.5 text-sm text-text-muted">
            {t(
              "branding.subtitle",
              "Customize the app's global appearance (name, colors, logo, favicon).",
            )}
          </p>
        </div>
      </header>

      <div className="flex justify-start">
        <ProGate feature="branding" />
      </div>
    </div>
  );
}
