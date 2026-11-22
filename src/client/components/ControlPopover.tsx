import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useRef,
} from "react";
import { cn } from "@/client/lib/utils";

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (e) => e.tabIndex >= 0,
  );
}

// A popover that holds CONTROLS (a list of choices, a filter editor), the counterpart of `Popover`,
// which holds prose. It opens on a click only, takes focus when it opens (its first tabbable element,
// so a list with one Tab stop opens on that stop), closes on Escape or a click outside, and hands focus
// back to the trigger. Tab past its last control closes it and goes on to what follows the trigger, and
// Shift+Tab before its first goes back to the trigger: Radix loops Tab inside a popover even when it is
// not modal, which would hold the keyboard there. Radix gives the trigger `aria-haspopup="dialog"`,
// `aria-expanded` and `aria-controls`, and the box `role="dialog"`, named by `label`.
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
  // Where the focus goes when the box closes because Tab left it; null hands it back to the trigger.
  const leaveTo = useRef<HTMLElement | null>(null);
  const leaveOnTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const box = e.currentTarget;
    const inside = tabbables(box);
    const edge = e.shiftKey ? inside[0] : inside[inside.length - 1];
    if (document.activeElement !== edge) return;
    e.preventDefault();
    if (!e.shiftKey) {
      const triggerEl = document.querySelector<HTMLElement>(
        `[aria-controls="${box.id}"]`,
      );
      const page = tabbables(document).filter((el) => !box.contains(el));
      leaveTo.current = triggerEl
        ? (page[page.indexOf(triggerEl) + 1] ?? null)
        : null;
    }
    onOpenChange(false);
  };
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          onKeyDown={leaveOnTab}
          onCloseAutoFocus={(e) => {
            const next = leaveTo.current;
            leaveTo.current = null;
            if (!next) return;
            e.preventDefault();
            next.focus();
          }}
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
