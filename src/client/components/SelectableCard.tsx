import type { LucideIcon } from "lucide-react";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/client/lib/utils";

interface SelectableCardProps {
  selected: boolean;
  onToggle: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  // Top-right slot — e.g. a kind <Badge> or a "Disabled" tag.
  badge?: ReactNode;
  disabled?: boolean;
  className?: string;
}

// A toggleable selection card (icon + title + description + badge), used across the agent editor
// for picking tools/integrations/knowledge bases. Selected = accent border + tint + a check. It is
// a real checkbox (role="checkbox" + aria-checked) so keyboard/AT users get the toggle semantics.
export function SelectableCard({
  selected,
  onToggle,
  title,
  description,
  icon: Icon,
  badge,
  disabled,
  className,
}: SelectableCardProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a styled selection card needs a button with the checkbox role, not a bare <input>.
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50",
        selected
          ? "border-accent bg-accent-soft"
          : "border-border bg-bg-secondary hover:bg-bg-hover",
        className,
      )}
    >
      {Icon && (
        <span
          className={cn(
            "mt-0.5 shrink-0",
            selected ? "text-accent" : "text-text-muted",
          )}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      )}
      {/* `data-selectable-content` lets a wrapper that overlays a control on the card (EditableCard's
          pencil) reserve room for it without reaching into this layout. The title wraps rather than
          truncates, and the badge drops to its own line when the two do not fit side by side, so a
          long tool name never cuts the title down to a few letters. */}
      <span
        data-selectable-content
        className="flex min-w-0 flex-1 flex-col gap-0.5"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words font-medium text-sm text-text-primary">
            {title}
          </span>
          {badge && <span className="min-w-0 max-w-full">{badge}</span>}
        </span>
        {description && (
          <span className="text-text-muted text-xs">{description}</span>
        )}
      </span>
      <span
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected
            ? "border-accent-solid bg-accent-solid text-accent-foreground"
            : "border-border text-transparent group-hover:border-text-muted",
        )}
        aria-hidden="true"
      >
        <Check className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}
