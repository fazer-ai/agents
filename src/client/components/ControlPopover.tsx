import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/client/lib/utils";

// A popover that holds CONTROLS (a list of choices, a filter editor), the counterpart of `Popover`,
// which holds prose. This one opens on a click only, takes focus when it opens (its first tabbable
// element, so a list with one Tab stop opens on that stop), closes on Escape or a click outside, and
// hands focus back to the trigger when it closes. Radix gives the trigger `aria-haspopup="dialog"`, `aria-expanded` and
// `aria-controls`, and the box `role="dialog"`, named by `label`.
export function ControlPopover({
  trigger,
  children,
  open,
  onOpenChange,
  label,
  align = "start",
  className,
}: {
  // A single element that forwards its ref (a native `<button>`).
  trigger: ReactElement;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          className={cn(
            // Capped by the viewport on both axes: a box wider or taller than the screen cannot be
            // rescued by collision handling, and on a phone the period's list is taller than the room
            // under the band.
            "data-[state=open]:fade-in-0 border-border bg-bg-primary text-text-primary data-[state=open]:animate-in z-(--z-popover) max-h-(--radix-popover-content-available-height) max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border shadow-lg",
            className,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
