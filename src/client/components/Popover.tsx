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
  // The box's own accessible name. Radix renders the content as `role="dialog"` and names it
  // nothing, so a screen reader announces "dialog" and every help box on a page is the same
  // unnamed one: the reader who lands in it by mistake, or comes back to it later, has no way to
  // tell WHICH help they are in. The trigger's name does not carry over: `aria-controls` points
  // at the box, it does not name it.
  label?: string;
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
// every caller pass JSX, which would put markup in the translation catalogue, where a translator
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

// The counterpart to `Tooltip`, for content the operator has to READ rather than glance at. A Radix
// tooltip cannot be opened on a touch device (@radix-ui/react-tooltip closes every route in for a
// tap: pointermove ignores touch, pointerdown blocks the focus open, click closes), and the console
// has a mobile drawer. THIS ONE OPENS on a click (every input method, Enter/Space and touch
// included) and, for a fine pointer only, on hover. A hovered box follows the pointer away; a clicked
// one stays until dismissed, so the text can be read, selected and copied. Hover never takes focus,
// which would pull it out of the field being filled.
export function Popover({
  content,
  children,
  label,
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
  // Whether the close now arriving came from the TRIGGER's own click. Radix reports the trigger
  // click, Escape and an outside click through the same `onOpenChange(false)`, and only the first may
  // pin: without this flag, Escape on a hover-opened box would pin it on screen.
  const fromTrigger = useRef(false);
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
      // race the click that follows: the box would open on enter and toggle shut on click.
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
        const byTrigger = fromTrigger.current;
        fromTrigger.current = false;
        if (next) {
          pinned.current = true;
          cancelClose();
          setOpen(true);
          return;
        }
        // A close from the TRIGGER, on a box that a hover had opened, is the click that pins it:
        // otherwise the gesture that lets somebody READ the text is the one that takes it away.
        // Every other close (Escape, outside click, a second click on the trigger) dismisses.
        if (byTrigger && !pinned.current) {
          pinned.current = true;
          // The close timer a preceding `pointerleave` armed is still running, and pinning does not
          // disarm it on its own. Reachable: tab to the trigger, hover it (opens), move the pointer
          // away (arms the timer), press Enter inside 140ms. The box would pin and then vanish, and
          // `pinned` would stay true on a closed box, after which the next hover opens a box that
          // `closeOnLeave` refuses to close.
          cancelClose();
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
        // Runs BEFORE Radix's own handler (it composes ours first), so the flag is set by the time
        // `onOpenToggle` reports the close.
        onClick={() => {
          fromTrigger.current = true;
        }}
      >
        {children}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          aria-label={label}
          onPointerEnter={cancelClose}
          onPointerLeave={closeOnLeave}
          // NOTE: FOCUS NEVER ENTERS THE BOX. Radix hands `FocusScope` a hard-coded `loop: true` even when
          // non-modal, which arms its Tab handler; with prose inside there is nothing tabbable, so the scope
          // focuses its container and swallows every Tab and Shift+Tab, stranding a keyboard user
          // (@radix-ui/react-focus-scope's handleKeyDown). The trigger keeps focus instead, the ordinary
          // non-modal disclosure: it carries `aria-expanded` and `aria-controls`, and Escape works from
          // anywhere because DismissableLayer listens on the document.
          onOpenAutoFocus={(e) => e.preventDefault()}
          // And it must not move focus on the way out either. Radix's non-modal close focuses the
          // trigger unless the event is defaulted away, so a box that merely followed the pointer
          // would, 140ms after the pointer left, pull focus out of the field being typed into and
          // onto the `?`. Nothing to restore, either: focus never left where it was.
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn(
            // The width is capped by the VIEWPORT as well as by the design: a fixed 24rem is most
            // of a 375px screen once collision padding is taken out, and a box that is wider than
            // the screen cannot be rescued by collision handling.
            //
            // `text-sm` and not the `text-xs` a tooltip uses: this box exists to be READ, not
            // glanced at, and 24rem at 14px lands around 50 characters a line, inside the measure
            // prose wants. The colour is the primary one for the same reason: a muted tone is for
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
