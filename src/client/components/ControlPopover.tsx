import * as PopoverPrimitive from "@radix-ui/react-popover";
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/client/lib/utils";

// Every element a browser puts in the Tab order without a `tabindex`, plus those given one: the
// candidate list the `tabbable` library walks.
const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "details > summary:first-of-type",
  "audio[controls]",
  "video[controls]",
  "iframe",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

// Whether Tab can land on a focusable element: enabled (a disabled fieldset included), not inert, shown.
function reachable(el: HTMLElement): boolean {
  // The attribute and not `tabIndex`: a summary reports -1 in some engines and is still a stop.
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null && Number(tabindex) < 0) return false;
  if (el.closest("[hidden], [inert]") || el.matches(":disabled")) return false;
  return shown(el) && !inDisabledFieldset(el);
}

// A disabled fieldset disables its form controls, except those in its first legend; a link inside stays.
function inDisabledFieldset(el: HTMLElement): boolean {
  if (!el.matches("button, input, select, textarea")) return false;
  const fieldset = el.closest("fieldset[disabled]");
  if (!fieldset) return false;
  const legend = fieldset.querySelector(":scope > legend");
  return !legend?.contains(el);
}

function shown(el: HTMLElement): boolean {
  return typeof el.checkVisibility === "function"
    ? el.checkVisibility({ visibilityProperty: true })
    : el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== "hidden";
}

// The elements Tab stops on, in document order, as a browser walks them: the reachable ones, and of a
// radio group (same name, same form) only its checked radio, or its first reachable one while none is.
export function tabStops(root: ParentNode): HTMLElement[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE),
  ).filter(reachable);
  return candidates.filter((el) => {
    if (!(el instanceof HTMLInputElement && el.type === "radio" && el.name))
      return true;
    const group = candidates.filter(
      (r): r is HTMLInputElement =>
        r instanceof HTMLInputElement &&
        r.type === "radio" &&
        r.name === el.name &&
        r.form === el.form,
    );
    return (group.find((r) => r.checked) ?? group[0]) === el;
  });
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
  // The trigger, read when the box opens: by the time it closes the box is gone, and with it the
  // `aria-controls` link that finds the trigger.
  const triggerRef = useRef<HTMLElement | null>(null);
  // Where the focus goes when the box closes because Tab left it: the stop after the trigger, or the trigger.
  const leaveTo = useRef<HTMLElement | null>(null);
  // A control removed while it held the focus (Back taking away a field the editor showed) drops the
  // focus onto the page; it comes back to the box's first control, a frame later so a caller that puts
  // it somewhere more precise goes first.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const at = document.activeElement;
      if (at && !at.matches("body, main")) return;
      tabStops(boxRef.current ?? document)
        .find(
          (el) =>
            !el.hasAttribute("data-focus-exit") && boxRef.current?.contains(el),
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  });
  const leave = (forward: boolean) => {
    const box = boxRef.current;
    const triggerEl = triggerRef.current;
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
          // NOTE: the box itself holds the focus when it has no control (all disabled) or after a click on
          // its text. Tab from there goes to its first control, or leaves when it has none; Shift+Tab
          // leaves for the trigger, as from its first stop.
          onKeyDown={(e) => {
            if (e.key !== "Tab" || e.target !== boxRef.current) return;
            e.preventDefault();
            const first = e.shiftKey
              ? undefined
              : tabStops(boxRef.current).find(
                  (el) => !el.hasAttribute("data-focus-exit"),
                );
            if (first) first.focus();
            else leave(!e.shiftKey);
          }}
          onOpenAutoFocus={(e) => {
            const box = boxRef.current;
            triggerRef.current = box
              ? document.querySelector<HTMLElement>(
                  `[aria-controls="${box.id}"]`,
                )
              : null;
            const first = tabStops(boxRef.current ?? document).find(
              (el) => !el.hasAttribute("data-focus-exit"),
            );
            // NOTE: with no control to take it (all disabled), the box itself holds the focus: Radix's
            // default would pick the edge stop, which closes the box the moment it opens.
            e.preventDefault();
            (first ?? boxRef.current)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            const next = leaveTo.current;
            leaveTo.current = null;
            const triggerEl = triggerRef.current;
            if (next) {
              next.focus();
              // A stop that would not take the focus leaves it to Radix, which hands it to the trigger.
              if (document.activeElement === next) e.preventDefault();
              return;
            }
            // NOTE: after a click outside, Radix leaves the focus where the click put it; a click on
            // nothing focusable leaves it on the page (the body, or the `<main tabIndex={-1}>` that holds
            // it), and then it goes back to the trigger without scrolling there. Any other element the click
            // focused (a chart's day detail) keeps it.
            requestAnimationFrame(() => {
              const at = document.activeElement;
              if (!at || at.matches("body, main"))
                triggerEl?.focus({ preventScroll: true });
            });
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
