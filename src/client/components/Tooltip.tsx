import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/client/lib/utils";

interface TooltipBaseProps {
  // A plain string (rendered with whitespace-pre-wrap so `\n` works) or rich JSX for structured
  // tooltips (headers, chips, distinct callout blocks).
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  // Override/extend the content container's classes (e.g. a wider max-w for rich tooltips). When
  // omitted, the default max-w-xs applies.
  contentClassName?: string;
}

// NOTE: when `asChild` is true (default), children is passed directly as the
// trigger via Radix Slot, which requires a single ReactElement. When `asChild`
// is false, children is wrapped by Radix Trigger, so any ReactNode is fine. The
// discriminated union below surfaces that constraint at the type level instead
// of at runtime.
//
// CHILDREN IS REQUIRED, and used to be optional: a `<Tooltip content=… />` with
// nothing inside rendered its own `?` button. That made a tooltip look exactly
// like the help affordance while being a different thing — and one that no
// phone can open, since a Radix tooltip has no touch route in (Popover.tsx).
// Help behind a `?` is `HelpPopover`; a tooltip LABELS something that is already
// on screen, so it always has a child to label.
type TooltipProps =
  | (TooltipBaseProps & { asChild?: true; children: ReactElement })
  | (TooltipBaseProps & { asChild: false; children: ReactNode });

// NOTE: when asChild=true (default), Radix Slot clones `children` and merges
// props — including `className`. If the cloned child receives a function
// className (e.g. `<NavLink className={({ isActive }) => ...}>`), Slot
// stringifies it during the merge and the serialized function ends up in the
// rendered `class` attribute. If you hit that, wrap the child in a plain
// `<span>` so Slot clones the span instead; the inner component keeps its own
// className semantics. See Sidebar.tsx.
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  sideOffset = 6,
  asChild = true,
  contentClassName,
}: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild={asChild}>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            "data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 z-(--z-tooltip) whitespace-pre-wrap break-words rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-text-primary text-xs shadow-lg data-[state=closed]:animate-out data-[state=delayed-open]:animate-in",
            contentClassName ?? "max-w-xs",
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
