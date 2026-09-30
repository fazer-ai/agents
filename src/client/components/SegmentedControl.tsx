import type { ComponentType, SVGProps } from "react";
import { useId } from "react";
import { cn } from "@/client/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

// A radio group drawn as one segmented pill, for a setting with two to
// four mutually exclusive values. Real radio inputs, so arrow keys move the
// selection and the group is announced as one choice.
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ...aria
}: SegmentedControlProps<T>) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md border border-border bg-bg-tertiary p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <label
            key={option.value}
            data-clickable="true"
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-border-focus",
              {
                "bg-bg-hover font-medium text-text-primary": selected,
                "text-text-muted hover:text-text-primary": !selected,
              },
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
