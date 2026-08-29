import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/client/lib/utils";

interface PopoverProps {
  // A plain string (rendered with whitespace-pre-wrap so `\n` works) or rich JSX.
  content: ReactNode;
  // The trigger. Always required, unlike Tooltip's optional `?` fallback: a popover is opened
  // deliberately, so the thing that opens it has to be something the caller chose to be clickable.
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  contentClassName?: string;
}

// How long the box survives after the pointer leaves. It exists for the gap between the trigger and
// the box (`sideOffset`), which the pointer has to cross to reach the text: without it, the content
// closes underneath a pointer that is on its way there.
const CLOSE_DELAY_MS = 140;

// A string `content` is split on blank lines and rendered as paragraphs. The alternative was to make
// every caller pass JSX, which would put markup in the translation catalogue — where a translator
// cannot see it, a lint rule cannot check it, and one missing tag breaks a page. A blank line is
// something a catalogue holds natively and a translator already understands.
//
// One paragraph is the common case and renders as one <p>, so this costs nothing where it is not
// used. Where it is, the shape it encourages is the one long help text needs: what this is, what it
// does, and the caveat, in three short paragraphs instead of one wall.
function renderContent(content: ReactNode): ReactNode {
  if (typeof content !== "string") return content;
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length <= 1) {
    return <p className="whitespace-pre-wrap break-words">{content}</p>;
  }
  // The gap has to beat the LEADING, not merely exist: `leading-relaxed` already puts ~9px between
  // two lines of the same paragraph, so a smaller paragraph gap makes the break invisible and the
  // three paragraphs read as one block again.
  return (
    <div className="space-y-3">
      {paragraphs.map((p) => (
        <p key={p} className="whitespace-pre-wrap break-words">
          {p}
        </p>
      ))}
    </div>
  );
}

// The counterpart to `Tooltip`, for content the operator has to be able to READ rather than glance
// at. The two are not interchangeable, and the line between them is not a matter of taste.
//
// A Radix tooltip cannot be opened on a touch device. Measured in `@radix-ui/react-tooltip@1.2.16`,
// where three handlers close every route in: `onPointerMove` returns early for
// `pointerType === "touch"`, `onPointerDown` raises the flag that `onFocus` then consults before
// opening, and `onClick` closes. A tap fires pointerdown → focus → click in that order, so the flag
// is already up when focus arrives. The console has a mobile drawer (`md:hidden` in Sidebar), so
// that is not a hypothetical viewport.
//
// THIS ONE OPENS THREE WAYS, and the three are one behaviour rather than a desktop mode and a touch
// mode: a click (which every input method produces, touch and Enter/Space included), and — for a
// fine pointer only — hovering, which is the cheap glance a tooltip was good for. The difference
// between the two is what happens when the pointer leaves: a hovered box follows the pointer away,
// a clicked one stays until it is dismissed, so the text can be read slowly, selected and copied.
//
// Hover never takes focus. Moving the mouse across a form would otherwise pull focus out of the
// field being filled, which is the one thing a passing glance must not do.
export function Popover({
  content,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  contentClassName,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  // Opened deliberately (click, Enter, tap) rather than by a pointer passing over. Kept in a ref
  // because the pointer handlers read it from inside timers, where a state value would be the one
  // captured when the timer was armed.
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(() => cancelClose, [cancelClose]);

  const openOnHover = useCallback(
    (e: React.PointerEvent) => {
      // Coarse pointers get nothing here: a tap emits pointerenter too, and opening on it would
      // race the click that follows — the box would open on enter and toggle shut on click.
      if (e.pointerType === "touch") return;
      cancelClose();
      setOpen(true);
    },
    [cancelClose],
  );

  const closeOnLeave = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "touch" || pinned.current) return;
      cancelClose();
      closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
    },
    [cancelClose],
  );

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // Radix reports the trigger's own click, Escape and an outside click through here. A click
        // is the only one that arrives while the box is already open from a hover, and it should
        // pin rather than toggle shut — otherwise the gesture that lets somebody READ the text is
        // the one that takes it away.
        if (next) {
          pinned.current = true;
          cancelClose();
          setOpen(true);
          return;
        }
        if (!pinned.current && open) {
          pinned.current = true;
          return;
        }
        pinned.current = false;
        setOpen(false);
      }}
    >
      <PopoverPrimitive.Trigger
        asChild
        onPointerEnter={openOnHover}
        onPointerLeave={closeOnLeave}
      >
        {children}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          onPointerEnter={cancelClose}
          onPointerLeave={closeOnLeave}
          // A box that appeared because the pointer passed over must not steal focus from the field
          // being filled. One opened on purpose does take it, which is what a keyboard user needs.
          onOpenAutoFocus={(e) => {
            if (!pinned.current) e.preventDefault();
          }}
          className={cn(
            // The width is capped by the VIEWPORT as well as by the design: a fixed 24rem is most
            // of a 375px screen once collision padding is taken out, and a box that is wider than
            // the screen cannot be rescued by collision handling.
            //
            // `text-sm` and not the `text-xs` a tooltip uses: this box exists to be READ, not
            // glanced at, and 24rem at 14px lands around 50 characters a line, inside the measure
            // prose wants. The colour is the primary one for the same reason — a muted tone is for
            // text competing with something else on the page, and nothing competes in here.
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 z-(--z-tooltip) w-max max-w-[min(24rem,calc(100vw-2rem))] rounded-md border border-border bg-bg-primary px-3.5 py-3 text-sm text-text-primary leading-relaxed shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in",
            contentClassName,
          )}
        >
          {renderContent(content)}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
