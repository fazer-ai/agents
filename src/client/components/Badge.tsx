import { cn } from "@/client/lib/utils";

type BadgeVariant =
  | "primary"
  | "secondary"
  | "success"
  | "warning"
  | "info"
  | "error";

// Each tone is its status color over its own soft tint, the pair
// tests/client/theme-contrast.test.ts measures, so a badge is readable by
// construction instead of by a separate set of badge-only colors.
const VARIANT_COLORS: Record<BadgeVariant, string> = {
  primary: "bg-accent-soft text-accent",
  secondary: "bg-bg-hover text-text-secondary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
  error: "bg-error-soft text-error",
};

export function Badge({
  children,
  variant = "secondary",
  className,
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 font-medium text-xs leading-none",
        VARIANT_COLORS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
