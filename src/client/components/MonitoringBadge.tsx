import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "./Badge";

// The "monitoring" marker (issue #209), next to TestModeBadge: the agent is bound and reads
// everything, and never answers. One state only — unlike test mode, nothing activates it.
export function MonitoringBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="secondary" className="flex items-center gap-1">
      <Eye className="h-3 w-3" aria-hidden="true" />
      {t("monitoring.badge.agent", "Monitoring")}
    </Badge>
  );
}
