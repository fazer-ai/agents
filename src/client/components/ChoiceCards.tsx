import type { ComponentType, ReactNode } from "react";
import { useId } from "react";
import { cn } from "@/client/lib/utils";

export interface ChoiceCardOption<T extends string> {
  value: T;
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  // One line on what the option does and the consequence that matters.
  hint: ReactNode;
  testId?: string;
}

interface ChoiceCardsProps<T extends string> {
  value: T;
  options: ChoiceCardOption<T>[];
  onChange: (value: T) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  // The grid columns; one column on a phone either way.
  className?: string;
}

// A single choice drawn as cards (agents#1254), for an option that changes what the thing does or
// which configuration appears below it, where the operator needs a sentence to choose well. A view
// toggle or a short self-explanatory value stays a SegmentedControl. Real radio inputs, like
// SegmentedControl: the group is one Tab stop, the arrows move the choice, it is announced as one
// choice, and clicking the card already chosen changes nothing.
export function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
  className,
  ...aria
}: ChoiceCardsProps<T>) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      data-choice-cards
      className={cn("grid gap-3", className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <label
            key={o.value}
            data-clickable="true"
            className={cn(
              "flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-border-focus",
              on
                ? "border-accent bg-accent-soft"
                : "border-border bg-bg-secondary hover:bg-bg-hover",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={on}
              onChange={() => onChange(o.value)}
              data-testid={o.testId}
              className="sr-only"
            />
            <span className="flex items-center gap-2 font-medium text-sm text-text-primary">
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0",
                  on ? "text-accent" : "text-text-muted",
                )}
              />
              {o.title}
            </span>
            <span data-choice-hint className="text-text-muted text-xs">
              {o.hint}
            </span>
          </label>
        );
      })}
    </div>
  );
}
