import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/client/lib/utils";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "border-border bg-bg-secondary rounded-lg border p-5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
