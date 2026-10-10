import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Button } from "@/client/components/Button";
import { useToast } from "@/client/components/Toast";
import { useAuth } from "@/client/contexts/AuthContext";
import { useProactiveBreaker } from "@/client/contexts/ProactiveBreakerContext";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { isAdminRole } from "@/client/lib/roles";

export const PROACTIVE_BREAKER_SETTINGS_PATH =
  "/resources/advanced?section=proactive-breaker";

// Shown on every console page while the account's proactive breaker is tripped. Alert channels are
// opt-in, so this is the one place an operator is sure to learn that proactive messages stopped, with
// the two ways out next to the sentence. Not dismissible: it goes away when the breaker reopens.
export function ProactiveBreakerBanner() {
  const { t, i18n } = useTranslation();
  const { status, set } = useProactiveBreaker();
  const { user } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [resuming, setResuming] = useState(false);

  const tripped = status?.tripped;
  if (!tripped) return null;
  const isAdmin = isAdminRole(user?.role);
  const nf = new Intl.NumberFormat(i18n.language);
  const since = new Date(tripped.at).toLocaleString(i18n.language, {
    dateStyle: "short",
    timeStyle: "short",
  });

  async function resume() {
    setResuming(true);
    try {
      const { data, error } =
        await api.api.v1["tenant-settings"]["proactive-breaker"].resume.post();
      if (error || !data) throw error ?? new Error("no data");
      set(data.proactiveBreaker);
      showToast(
        t("proactiveBreaker.resumed", "Proactive messages resumed."),
        "success",
      );
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t(
            "proactiveBreaker.resumeError",
            "Could not resume proactive messages.",
          ),
        "error",
      );
    } finally {
      setResuming(false);
    }
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-error border-b bg-error-soft px-4 py-2.5"
    >
      <TriangleAlert
        className="h-4 w-4 shrink-0 text-error"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 text-sm text-text-primary">
        {t(
          "proactiveBreaker.banner",
          "Proactive messages paused since {{since}}: {{sent}} sent in 24h, limit {{limit}}.",
          {
            since,
            sent: nf.format(tripped.count),
            limit: nf.format(tripped.limit),
          },
        )}
        {!isAdmin && (
          <span className="ml-1 text-text-secondary">
            {t(
              "proactiveBreaker.bannerAskAdmin",
              "An admin of this account can resume them.",
            )}
          </span>
        )}
      </span>
      {isAdmin && (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" onClick={resume} loading={resuming}>
            {t("proactiveBreaker.resume", "Resume")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigate(PROACTIVE_BREAKER_SETTINGS_PATH)}
          >
            {t("proactiveBreaker.changeLimit", "Change limit")}
          </Button>
        </div>
      )}
    </div>
  );
}
