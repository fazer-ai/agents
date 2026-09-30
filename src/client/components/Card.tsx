import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/client/lib/utils";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ children, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-bg-secondary p-5",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
