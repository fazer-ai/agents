import * as PopoverPrimitive from "@radix-ui/react-popover";
import { type ReactElement, type ReactNode, useRef } from "react";
import { cn } from "@/client/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The elements Tab stops on, in document order: focusable, shown, and of a radio group only the checked
// radio (the first one while none is checked), as a browser walks them.
export function tabStops(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => {
      if (el.tabIndex < 0 || el.closest("[hidden]")) return false;
      const shown =
        typeof el.checkVisibility === "function"
          ? el.checkVisibility()
          : el.getClientRects().length > 0;
      if (!shown) return false;
      if (el instanceof HTMLInputElement && el.type === "radio" && el.name) {
        const group = Array.from(
          root.querySelectorAll<HTMLInputElement>(
            `input[type="radio"][name="${CSS.escape(el.name)}"]`,
          ),
        );
        const stop = group.find((r) => r.checked) ?? group[0];
        return stop === el;
      }
      return true;
    },
  );
}

// A popover that holds CONTROLS (a list of choices, a filter editor), the counterpart of `Popover`,
// which holds prose. It opens on a click only, focuses its first control, closes on Escape or a click
// outside, and hands focus back to the trigger. Two edge stops let the keyboard out, since Radix loops
// Tab inside a popover even when it is not modal: tabbing past the last control (inside a date field's
// parts too, which the browser walks itself) closes it and goes on to the stop after the trigger, and
// tabbing back past the first returns to the trigger. Radix gives the trigger `aria-haspopup`,
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
  const boxRef = useRef<HTMLDivElement>(null);
  // Where the focus goes when the box closes because Tab left it: the stop after the trigger, or the trigger.
  const leaveTo = useRef<HTMLElement | null>(null);
  const leave = (forward: boolean) => {
    const box = boxRef.current;
    const triggerEl = box
      ? document.querySelector<HTMLElement>(`[aria-controls="${box.id}"]`)
      : null;
    leaveTo.current = triggerEl;
    if (forward && box && triggerEl) {
      const page = tabStops(document).filter((el) => !box.contains(el));
      leaveTo.current = page[page.indexOf(triggerEl) + 1] ?? triggerEl;
    }
    onOpenChange(false);
  };
  // An invisible stop at each edge of the box, whose only job is to catch Tab leaving it.
  const edge = (forward: boolean) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: receiving focus is the stop's whole behavior.
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the stop has to be reachable by Tab to catch it.
      tabIndex={0}
      data-focus-exit={forward ? "after" : "before"}
      onFocus={() => leave(forward)}
      className="sr-only"
    />
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={boxRef}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          onOpenAutoFocus={(e) => {
            const first = tabStops(boxRef.current ?? document).find(
              (el) => !el.hasAttribute("data-focus-exit"),
            );
            if (!first) return;
            e.preventDefault();
            first.focus();
          }}
          onCloseAutoFocus={(e) => {
            const next = leaveTo.current;
            leaveTo.current = null;
            if (!next) return;
            next.focus();
            // A stop that would not take the focus leaves it to Radix, which hands it to the trigger.
            if (document.activeElement === next) e.preventDefault();
          }}
          className={cn(
            // Capped by the viewport on both axes: a box wider or taller than the screen cannot be
            // rescued by collision handling, and on a phone the period's list is taller than the room
            // under the band.
            "data-[state=open]:fade-in-0 border-border bg-bg-primary text-text-primary data-[state=open]:animate-in z-(--z-popover) max-h-(--radix-popover-content-available-height) max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border shadow-lg",
            className,
          )}
        >
          {edge(false)}
          {children}
          {edge(true)}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
