import { useTranslation } from "react-i18next";
import { Badge } from "@/client/components/Badge";
import { cn } from "@/client/lib/utils";

// The one rendering of a role, wherever the console shows one (users table, pending invitations,
// profile, user menu), so the same role never reads as two different things. A role is not a
// status, so no tone here is a warning or an error.
type Role = "SUPER_ADMIN" | "TENANT_ADMIN" | "AGENT";

const VARIANT = {
  SUPER_ADMIN: "purple",
  TENANT_ADMIN: "primary",
  AGENT: "secondary",
} as const;

export function useRoleLabel(): (role: string) => string {
  const { t } = useTranslation();
  return (role) => {
    switch (role) {
      case "SUPER_ADMIN":
        return t("role.superAdmin", "Super admin");
      case "TENANT_ADMIN":
        return t("role.tenantAdmin", "Tenant admin");
      default:
        return t("role.agent", "Agent");
    }
  };
}

export function RoleBadge({
  role,
  className,
}: {
  role: string;
  className?: string;
}) {
  const label = useRoleLabel();
  return (
    <Badge
      variant={role in VARIANT ? VARIANT[role as Role] : "secondary"}
      className={cn("whitespace-nowrap", className)}
    >
      {label(role)}
    </Badge>
  );
}
