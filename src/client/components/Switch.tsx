import { cn } from "@/client/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

// Accessible on/off toggle (role="switch"). Cursor is handled globally for
// [role="button"]; the switch is a <button> so it inherits the pointer cursor.
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  ...aria
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50",
        checked ? "bg-accent-solid" : "bg-bg-hover",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full shadow transition-transform",
          checked
            ? "translate-x-4 bg-accent-foreground"
            : "translate-x-0.5 bg-text-muted",
        )}
      />
    </button>
  );
}
