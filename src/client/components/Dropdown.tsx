import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/client/lib/utils";

export interface DropdownItem {
  value: string;
  label: string;
  // Optional second line under the label (e.g. a hint or secondary detail).
  description?: string;
  // Optional leading icon, for lists whose items are kinds of thing the operator scans by shape.
  icon?: LucideIcon;
  // Disabled items stay VISIBLE (shaded, not selectable) with `disabledHint` explaining why — so the
  // operator sees the option exists and learns the reason it is unavailable.
  disabled?: boolean;
  disabledHint?: string;
}

// Custom value-picker over Radix DropdownMenu, replacing the native <select> where we need disabled
// options to remain visible with a reason. Content z sits above modals (--z-popover) so it works
// inside dialogs. Trigger is full-width and truncates; the content matches the trigger width.
export function Dropdown({
  value,
  onChange,
  items,
  placeholder,
  ariaLabel,
  disabled,
  align = "start",
  triggerClassName,
}: {
  value: string | null;
  onChange: (value: string) => void;
  items: DropdownItem[];
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  align?: "start" | "end";
  triggerClassName?: string;
}) {
  const current = items.find((i) => i.value === value) ?? null;
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            "border-border-hover bg-bg-tertiary text-text-primary focus:border-border-focus focus:ring-accent-soft flex min-h-8 w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1 text-sm transition-colors focus:ring-2 focus:outline-none disabled:opacity-60",
            triggerClassName,
          )}
        >
          <span className={cn("truncate", { "text-text-muted": !current })}>
            {current ? current.label : (placeholder ?? "")}
          </span>
          <ChevronDown
            className="text-text-muted h-4 w-4 shrink-0"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          sideOffset={4}
          className="border-border bg-bg-secondary z-(--z-popover) max-h-72 w-(--radix-dropdown-menu-trigger-width) min-w-56 overflow-y-auto rounded-lg border p-1 shadow-lg"
        >
          {items.map((item) =>
            item.disabled ? (
              <div
                key={item.value}
                aria-disabled="true"
                className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm opacity-50"
              >
                <span className="text-text-secondary truncate">
                  {item.label}
                </span>
                {item.disabledHint && (
                  <span className="text-text-muted text-xs">
                    {item.disabledHint}
                  </span>
                )}
              </div>
            ) : (
              <DropdownMenuPrimitive.Item
                key={item.value}
                className="text-text-secondary data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors outline-none"
                onSelect={() => onChange(item.value)}
              >
                {item.icon && (
                  <item.icon
                    className="text-text-muted h-4 w-4 shrink-0 self-start"
                    aria-hidden="true"
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{item.label}</span>
                  {item.description && (
                    <span className="text-text-muted truncate text-xs">
                      {item.description}
                    </span>
                  )}
                </div>
                {value === item.value && (
                  <Check
                    className="text-accent h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                )}
              </DropdownMenuPrimitive.Item>
            ),
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
