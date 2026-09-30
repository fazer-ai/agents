import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ReactElement, type ReactNode, useState } from "react";
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
  // Keeps the tooltip mounted but closed. For a control whose label is only hidden in some states
  // (the collapsed sidebar): wrapping it conditionally swaps the element tree, which unmounts the
  // control and drops keyboard focus the moment the state flips.
  disabled?: boolean;
}

// With `asChild` (the default) children is the trigger through Radix Slot, which needs a single
// ReactElement; without it Radix Trigger wraps any ReactNode, and the union below says so in the type.
// CHILDREN IS REQUIRED: a tooltip LABELS something already on screen. A childless tooltip rendering
// its own `?` would look like the help affordance while no phone can open it (a Radix tooltip has no
// touch route in, see Popover.tsx); help behind a `?` is `HelpPopover`.
type TooltipProps =
  | (TooltipBaseProps & { asChild?: true; children: ReactElement })
  | (TooltipBaseProps & { asChild: false; children: ReactNode });

// When asChild=true (default), Radix Slot clones `children` and merges
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
  disabled = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipPrimitive.Root open={open && !disabled} onOpenChange={setOpen}>
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
