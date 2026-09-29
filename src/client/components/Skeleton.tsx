import type { HTMLAttributes } from "react";
import { cn } from "@/client/lib/utils";

// Decorative placeholder for loading content. Skeletons are the default
// loading indicator in this app (spinners are reserved for button states and
// the app-boot/auth splash). Compose several to mirror the real layout, e.g.
// <Skeleton className="h-4 w-32" />. The animate-pulse is neutralized by the
// global prefers-reduced-motion rule in public/index.css.
export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-bg-tertiary", className)}
      {...props}
    />
  );
}
