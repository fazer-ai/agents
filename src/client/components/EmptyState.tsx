import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/client/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

// Centered empty/zero-state block: icon + title + optional description + a
// call-to-action (e.g. "Create your first agent"). Use inside a <Card> or as the
// `empty` slot of <DataBoundary>.
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="bg-bg-tertiary rounded-full p-3">
          <Icon className="text-text-muted h-6 w-6" aria-hidden="true" />
        </div>
      )}
      <div>
        <p className="text-text-primary font-medium">{title}</p>
        {description && (
          <p className="text-text-muted mt-1 text-sm">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
