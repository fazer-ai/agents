import type { LucideIcon } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/client/lib/utils";

export interface TabItem {
  key: string;
  label: string;
  icon?: LucideIcon;
  // NOTE: optional count pill (e.g. pending approvals). Rendered only when > 0.
  badge?: number;
  // NOTE: optional unsaved-changes dot for forms split across tabs.
  dirty?: boolean;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
  "aria-label"?: string;
}

// Horizontal tablist (in-page, not routed). The consumer renders the active
// panel based on `value`. Arrow keys move selection (roving focus). For routed
// sections use React Router + <Outlet> instead (see AdminLayout/SettingsLayout).
export function Tabs({
  items,
  value,
  onChange,
  className,
  ...aria
}: TabsProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + dir + items.length) % items.length;
    const target = items[next];
    if (!target) return;
    onChange(target.key);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={aria["aria-label"]}
      // NOTE: overflow-y-hidden is load-bearing — `overflow-x: auto` alone forces the y axis to
      // compute to `auto` too (CSS spec), and the tabs' `-mb-px` (1px over the border) then triggers
      // a spurious vertical scrollbar. Pinning y to hidden keeps only the horizontal scroll.
      className={cn(
        "flex gap-1 overflow-x-auto overflow-y-hidden border-border border-b",
        className,
      )}
    >
      {items.map((item, index) => {
        const active = item.key === value;
        const Icon = item.icon;
        return (
          <button
            key={item.key}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 font-medium text-sm transition-colors",
              active
                ? "border-accent text-text-primary"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
            {item.label}
            {item.badge != null && item.badge > 0 && (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-accent-solid px-1.5 py-0.5 font-medium text-[0.6875rem] text-accent-foreground leading-none">
                {item.badge}
              </span>
            )}
            {item.dirty && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
