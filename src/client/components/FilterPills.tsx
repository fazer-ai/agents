import { useRef } from "react";
import { cn } from "@/client/lib/utils";

export interface FilterPillItem {
  key: string;
  label: string;
  // NOTE: optional count pill (rendered only when > 0).
  count?: number;
}

interface FilterPillsProps {
  items: FilterPillItem[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
  "aria-label"?: string;
}

// Single-select segmented filter (a radiogroup of pills). Arrow keys move
// selection with roving focus, mirroring <Tabs>. Use it where a status/category
// filter has a small, fixed set of options — clearer than a <Select> dropdown.
export function FilterPills({
  items,
  value,
  onChange,
  className,
  ...aria
}: FilterPillsProps) {
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
      role="radiogroup"
      aria-label={aria["aria-label"]}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {items.map((item, index) => {
        const active = item.key === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: roving-focus pills are buttons with the radio role, not <input type="radio">.
          <button
            key={item.key}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium text-sm transition-colors",
              active
                ? "border-accent-solid bg-accent-solid text-accent-foreground"
                : "border-border bg-bg-tertiary text-text-secondary hover:bg-bg-hover",
            )}
          >
            {item.label}
            {item.count != null && item.count > 0 && (
              <span
                className={cn(
                  "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 font-medium text-[0.6875rem] leading-none",
                  active
                    ? "bg-accent-foreground/20 text-accent-foreground"
                    : "bg-bg-secondary text-text-muted",
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
