import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  useBackGuard,
  useBeforeUnload,
  useHeldDraft,
} from "@/client/lib/unsavedGuard";
import { cn } from "@/client/lib/utils";
import { Button } from "./Button";
import { DiscardDialog } from "./DiscardDialog";
import { handOverEscape } from "./escapeClaim";
import { RangeHolds } from "./NumberInput";

// Stacked modals resolve their z-index at runtime as `calc(var(--z-modal) + level * step)`, with
// `level` the modal's position in the open-stack, so the base stays defined once (public/index.css).
// The overlay sits one below its content, dimming the modal beneath. At level >0 the overlay-content
// gap collapses to 1, which only matters if a z-indexed layer is ever put between a content and its
// own overlay.
const MODAL_DEPTH_STEP = 2;
// With base 80 and step 2, level 5 reaches --z-toast (90). Warn before
// the collision so the conflict does not go silently wrong.
const MODAL_MAX_DEPTH = 4;

// The open modals, in open order, module-level so every <Modal> shares one stack. For SIBLING modals
// (rendered at the same React position) it gives what Radix's per-dialog primitives cannot: only the
// TOPMOST reacts to a backdrop click, since our `document` pointer listeners have no stacking
// awareness, and each modal's z derives from its position, so a later one and its overlay sit above
// every earlier one. Reactive via useSyncExternalStore so opening or closing one restacks the others.
let modalStack: string[] = [];
const modalStackListeners = new Set<() => void>();
function getModalStack(): string[] {
  return modalStack;
}
function subscribeModalStack(cb: () => void): () => void {
  modalStackListeners.add(cb);
  return () => {
    modalStackListeners.delete(cb);
  };
}
function pushModal(id: string): void {
  modalStack = [...modalStack, id];
  for (const l of modalStackListeners) l();
}
function popModal(id: string): void {
  const i = modalStack.lastIndexOf(id);
  if (i < 0) return;
  modalStack = [...modalStack.slice(0, i), ...modalStack.slice(i + 1)];
  for (const l of modalStackListeners) l();
}

// Wrap both branches in tuples to stop TS from distributing over union
// payload types. Without it, `T = Instance | null` collapses to a function
// union whose parameter becomes `Instance & null` (i.e. `never`) and no call
// typechecks.
// biome-ignore lint/suspicious/noConfusingVoidType: `void` is the sentinel for "no payload" and matches the generic default on useModalController; it is only ever used inside this type-level distribution check.
type OpenFn<T> = [T] extends [void]
  ? () => void
  : [T] extends [undefined]
    ? () => void
    : (payload: T) => void;

export type ModalController<T = void> = {
  isOpen: boolean;
  payload: T | undefined;
  open: OpenFn<T>;
  close: () => void;
};

const ModalControllerContext = createContext<ModalController<unknown> | null>(
  null,
);

// Lets a modal body report whether it has unsaved changes. Each <Modal>
// provides its own; a body (or descendant) calls `useUnsavedChanges(isDirty)`
// to register. The Modal aggregates all reporters and, when any is dirty,
// intercepts a user-driven close (Esc/outside/X/Back) with a discard
// confirmation. Null outside a <Modal> (e.g. an inline page form), where the
// hook falls back to the native beforeunload prompt only.
type ModalDirtyContextValue = {
  report: (id: string, dirty: boolean) => void;
};
const ModalDirtyContext = createContext<ModalDirtyContextValue | null>(null);

// Report unsaved changes from inside a modal body (or any descendant). When
// `isDirty` is true the enclosing <Modal> shows a "discard changes?" confirm on
// any user-driven close and arms the browser guards (native unload prompt +
// Back-button trap). Used outside a <Modal> (an inline page form), it still
// arms the native beforeunload prompt so a refresh/tab-close is guarded.
export function useUnsavedChanges(isDirty: boolean) {
  const ctx = useContext(ModalDirtyContext);
  const id = useId();
  useEffect(() => {
    ctx?.report(id, isDirty);
  }, [ctx, id, isDirty]);
  // Clear this reporter's bit when the body unmounts.
  useEffect(() => () => ctx?.report(id, false), [ctx, id]);
  // No enclosing modal → page form: drive the native prompt directly. Inside a
  // modal the <Modal> owns the unload prompt (gated on isOpen), so skip here.
  useBeforeUnload(!ctx && isDirty);
}

// Controller API — state lifted from the modal wrapper into a hook the
// parent owns. Payload is retained across `close()` so Radix can play its exit
// animation with the last-opened data still rendered; it's only overwritten
// on the next `open()`. Do NOT unmount the <Modal> via `{flag && <Modal/>}` —
// the Radix Dialog.Root must stay alive through the exit animation or it is
// skipped entirely.
export function useModalController<T = void>(opts?: {
  onOpen?: (payload: T | undefined) => void;
  onClose?: () => void;
}): ModalController<T> {
  const [isOpen, setIsOpen] = useState(false);
  const [payload, setPayload] = useState<T | undefined>(undefined);
  const onOpenRef = useRef(opts?.onOpen);
  const onCloseRef = useRef(opts?.onClose);
  onOpenRef.current = opts?.onOpen;
  onCloseRef.current = opts?.onClose;

  const open = useCallback((nextPayload?: T) => {
    setPayload(nextPayload);
    setIsOpen(true);
    onOpenRef.current?.(nextPayload);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    onCloseRef.current?.();
  }, []);

  return useMemo(
    () =>
      ({
        isOpen,
        payload,
        open: open as OpenFn<T>,
        close,
      }) satisfies ModalController<T>,
    [isOpen, payload, open, close],
  );
}

export function useModal<T = void>(): ModalController<T> {
  const ctx = useContext(ModalControllerContext);
  if (!ctx) {
    throw new Error(
      "useModal must be used inside a <Modal modal={...}> subtree.",
    );
  }
  return ctx as unknown as ModalController<T>;
}

// The guard-aware close. Footer buttons rendered inside a <Modal> (e.g. a
// "Cancel") MUST close through this, NOT through `modal.close()` — the latter is
// a PROGRAMMATIC close that bypasses the unsaved-changes confirmation by design
// (used by the parent after a successful save). `useModalClose()` funnels through
// `requestClose`, so a dirty form still gets the "discard changes?" prompt.
const ModalCloseContext = createContext<(() => void) | null>(null);

export function useModalClose(): () => void {
  const close = useContext(ModalCloseContext);
  if (!close) {
    throw new Error("useModalClose must be used inside a <Modal> subtree.");
  }
  return close;
}

// A footer "Cancel" button that closes through the guard (see useModalClose). Drop-in for the inline
// `<Button variant="secondary" onClick={() => modal.close()}>Cancel</Button>` pattern so a dirty form
// triggers the discard confirmation instead of silently closing.
export function ModalCancelButton({
  children,
  disabled,
}: {
  children?: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const close = useModalClose();
  return (
    <Button variant="secondary" onClick={close} disabled={disabled}>
      {children ?? t("common.cancel", "Cancel")}
    </Button>
  );
}

// Runs `effect` each time the controller's `isOpen` goes from false to true, and its cleanup when it
// goes back. Takes the controller rather than reading context, because it is called in the wrapper
// before `<Modal>` mounts its provider. The closure is refreshed every render without re-firing
// mid-open, which would clobber user edits on an unrelated prop change; to react to changes while
// the modal is open, use `useEffect` directly.
export function useOnModalOpen(
  modal: Pick<ModalController<unknown>, "isOpen">,
  // biome-ignore lint/suspicious/noConfusingVoidType: matches React's EffectCallback shape — `void` means "caller ignores any non-cleanup return", and `(() => void)` is the optional cleanup.
  effect: () => void | (() => void),
) {
  const { isOpen } = modal;
  const effectRef = useRef(effect);
  effectRef.current = effect;
  useEffect(() => {
    if (!isOpen) return;
    return effectRef.current();
  }, [isOpen]);
}

// A Radix dropdown/select/popover rendered inside the modal body portals its floating content to
// <body>, i.e. OUTSIDE the modal's contentRef. A press on that content (opening/closing the picker,
// choosing an item) would otherwise read as an outside-modal click and close the modal, surfacing
// the discard prompt when the form is dirty. Treat any target inside a Radix popper as inside the
// modal so those pickers don't trip the outside-click close.
export function isInsideRadixPopper(target: Node | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest(
      "[data-radix-popper-content-wrapper],[data-radix-menu-content],[role='menu'],[role='listbox']",
    )
  );
}

// A press whose coordinates fall within the modal content's box is never an outside
// dismiss, even when its DOM target is the overlay. This is the case whenever a nested
// Radix picker (dropdown/select/popover) is open in `modal` mode: Radix sets
// `pointer-events: none` on <body>, so the modal content (and every control in it) stops
// being the hit-test target and the press lands on the Dialog overlay behind it instead
// — which reads as an outside click even though the pointer is physically over the modal.
// Guarding by geometry keeps those in-modal clicks (toggling/closing the picker) from
// closing the whole modal, while a genuine backdrop click (outside the box) still dismisses.
function isPointerInsideRect(
  rect: DOMRect | undefined,
  clientX: number,
  clientY: number,
): boolean {
  return (
    !!rect &&
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}

// The layout height with its fraction (the computed `height` is the border-box one, since
// Tailwind's preflight sets `box-sizing: border-box`): offsetHeight rounds to a whole pixel, and a
// slide that starts or ends on the rounded value moves the bottom edge by a fraction against its
// direction. Falls back to offsetHeight where there is no layout (happy-dom).
function layoutHeight(node: HTMLElement): number {
  const height = Number.parseFloat(getComputedStyle(node).height);
  return Number.isFinite(height) ? height : node.offsetHeight;
}

// The computed `top`, which is where the box is painted in the middle of a transition too;
// offsetTop is rounded to a whole pixel and would move the box by a fraction when written back.
// Falls back to offsetTop where there is no layout (happy-dom).
function layoutTop(node: HTMLElement): number {
  const top = Number.parseFloat(getComputedStyle(node).top);
  return Number.isFinite(top) ? top : node.offsetTop;
}

// Every comparison of positions in the slide is on fractional geometry (the computed `top` and
// `height`, layout values, so the entry zoom does not count either) with this tolerance. offsetTop
// and offsetHeight round to whole pixels: at a 900px viewport an unchanged 865px box centered at
// 17.5px reads offsetTop 18, `18 + 865` reads as cut at the bottom edge, and a slide that moves
// nothing starts, settles on its 400ms timer and starts again for as long as the box is open.
const SUBPIXEL = 0.5;

interface ModalProps {
  children: ReactNode;
  // biome-ignore lint/suspicious/noExplicitAny: Modal only reads isOpen/close; accept any controller variant so ModalController<T> for any T can pass through without unsafe casts at every call site.
  modal: ModalController<any>;
  title?: string;
  description?: string;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  // NOTE: accessible name for the dialog when `title` is not rendered.
  // Assistive tech otherwise sees an unnamed dialog.
  ariaLabel?: string;
  // NOTE: when false, clicks outside the content do not close the modal.
  // Escape key still works. Use for flows where accidental dismiss is costly
  // (e.g. pricing/checkout modals).
  closeOnOutsideClick?: boolean;
  // NOTE: intercept user-driven close requests (Esc, outside click, X button)
  // to show a confirmation before closing. Called instead of `modal.close()`;
  // the handler is responsible for eventually calling `modal.close()` itself
  // (or not). Programmatic `modal.close()` calls from the parent are
  // unaffected. To block closing while a request is in flight, use `busy`.
  onCloseRequest?: () => void;
  // NOTE: a request this modal started is in flight. Every user-driven close
  // (Esc, outside click, X, Cancel, Back) does nothing, and the "discard
  // changes?" prompt never opens: offering to discard a write already on its
  // way tells the operator it was thrown away while it is being saved, and a
  // reopened form offers a second Save for it. Takes precedence over
  // `unsavedChanges` and `onCloseRequest`; the unload prompt stays armed while
  // dirty. Programmatic `modal.close()` is unaffected.
  busy?: boolean;
  // NOTE: when true, a user-driven close (Esc/outside/X/Back) is intercepted
  // with a "discard changes?" confirmation, and the browser guards (native
  // unload prompt + Back-button trap) are armed while the modal is open. Pass
  // the form's dirty flag. This is the ergonomic path when the form state lives
  // in the wrapper (outside the <Modal> subtree). A descendant body component
  // can instead call `useUnsavedChanges(isDirty)`; both are OR-ed together.
  // Takes precedence over `onCloseRequest` while dirty, and yields to `busy`.
  unsavedChanges?: boolean;
}

const sizeClasses = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-5xl",
};

export function Modal({
  children,
  modal,
  title,
  description,
  footer,
  size = "md",
  className,
  ariaLabel,
  closeOnOutsideClick = true,
  onCloseRequest,
  busy = false,
  unsavedChanges = false,
}: ModalProps) {
  const { t } = useTranslation();
  const { isOpen } = modal;
  const modalId = useId();
  const stack = useSyncExternalStore(subscribeModalStack, getModalStack);

  // Register in the shared open-stack on open (drop on close/unmount). Position in the stack =
  // open order, which drives BOTH the topmost-only dismissal and the z-index/overlay dimming.
  useEffect(() => {
    if (!isOpen) return;
    pushModal(modalId);
    return () => popModal(modalId);
  }, [isOpen, modalId]);

  // One per opening, set while rendering so the commit that opens the modal carries it: the
  // baseline of the slide below is taken again after every opening, even one whose pin is the same.
  const [openGeneration, setOpenGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setOpenGeneration((generation) => generation + 1);
  }

  // This modal's stacking level = its index in the open-stack. While it animates OUT (isOpen went
  // false, so it is popped from the stack but Radix's Presence still renders it through the exit),
  // retain the last level so its z does not drop mid-animation and slip behind a sibling.
  const liveIndex = stack.indexOf(modalId);
  const lastLevelRef = useRef(0);
  if (liveIndex >= 0)
    lastLevelRef.current = Math.min(liveIndex, MODAL_MAX_DEPTH);
  const stackLevel =
    liveIndex >= 0
      ? Math.min(liveIndex, MODAL_MAX_DEPTH)
      : lastLevelRef.current;

  // Aggregate unsaved-changes signals: the `unsavedChanges` prop (state in the
  // wrapper) OR-ed with reporters from descendant bodies (useUnsavedChanges,
  // for shared body components rendered inside the modal). When dirty AND open,
  // user-driven close is intercepted with a confirmation and the browser guards
  // (native unload prompt + Back-button trap) are armed.
  const dirtyIds = useRef<Set<string>>(new Set());
  const [hasDirty, setHasDirty] = useState(false);
  const report = useCallback((id: string, dirty: boolean) => {
    const ids = dirtyIds.current;
    if (dirty === ids.has(id)) return;
    if (dirty) ids.add(id);
    else ids.delete(id);
    setHasDirty(ids.size > 0);
  }, []);
  const dirtyCtx = useMemo(() => ({ report }), [report]);
  const guardActive = isOpen && (unsavedChanges || hasDirty);

  const [discardOpen, setDiscardOpen] = useState(false);
  const guardActiveRef = useRef(guardActive);
  guardActiveRef.current = guardActive;
  const closeRef = useRef(modal.close);
  closeRef.current = modal.close;
  const onCloseRequestRef = useRef(onCloseRequest);
  onCloseRequestRef.current = onCloseRequest;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Single funnel for every user-driven close (Esc, outside click, X, Back).
  // Busy → nothing; dirty → show the discard confirm; otherwise run the custom
  // onCloseRequest (if any) or close. Programmatic modal.close() from the parent
  // bypasses this.
  const requestClose = useCallback(() => {
    if (busyRef.current) return;
    if (guardActiveRef.current) {
      setDiscardOpen(true);
      return;
    }
    (onCloseRequestRef.current ?? closeRef.current)();
  }, []);

  // Reset the confirm if the modal is closed programmatically while it is open.
  useEffect(() => {
    if (!isOpen) setDiscardOpen(false);
  }, [isOpen]);

  useBeforeUnload(guardActive);
  // A save in flight also holds the console's own reloads (client/lib/staleBuild.ts), clean form
  // included: a stale tab's reload would end the request `busy` keeps the operator waiting on.
  useHeldDraft(isOpen && busy);
  // Back is trapped while busy too, dirty or not: without the trap it would navigate away from the
  // page with the request still out, which is the dismissal `busy` exists to refuse.
  useBackGuard(guardActive || (isOpen && busy), requestClose);
  // stackLevel (from the open-stack, already capped at MODAL_MAX_DEPTH) drives the z-index so
  // deeper stacks keep escalating without colliding with the toast layer at level 5+. The overlay
  // sits one step below its own content so it dims the modal beneath. The warning below still fires
  // so the collision is visible during development.
  const contentStyle =
    stackLevel > 0
      ? {
          zIndex: `calc(var(--z-modal) + ${stackLevel * MODAL_DEPTH_STEP})`,
        }
      : undefined;
  const overlayStyle =
    stackLevel > 0
      ? {
          zIndex: `calc(var(--z-modal) + ${stackLevel * MODAL_DEPTH_STEP - 1})`,
        }
      : undefined;
  const contentRef = useRef<HTMLDivElement>(null);
  // Close only when BOTH the press and the release land outside the content, so a drag released
  // outside (a text selection) does not close. Driven by our own document pointerdown/pointerup
  // listeners, NOT Radix's `onPointerDownOutside`: Radix dispatches that after `pointerup`, so a latch
  // set there is one gesture stale and closes the modal on the NEXT, unrelated click. This ref records,
  // per gesture, whether the pointerdown was outside.
  const pointerDownOutsideRef = useRef(false);

  useEffect(() => {
    if (isOpen && liveIndex > MODAL_MAX_DEPTH) {
      console.warn(
        `[Modal] stack depth ${liveIndex} reaches --z-toast (90); stop stacking here or bump z-index tokens.`,
      );
    }
  }, [isOpen, liveIndex]);

  useEffect(() => {
    if (!isOpen || !closeOnOutsideClick) return;
    // Is a press at this target/coords outside the modal content? A press inside a Radix
    // popper (dropdown/select portaled out of the body) counts as inside, and so does a
    // press whose coordinates land over the content box even if its DOM target is the
    // overlay — the latter happens whenever a nested Radix picker is open in `modal` mode
    // and sets `pointer-events: none` on <body> (see isPointerInsideRect).
    const isOutside = (
      target: Node | null,
      clientX: number,
      clientY: number,
    ) => {
      if (isInsideRadixPopper(target)) return false;
      if (
        isPointerInsideRect(
          contentRef.current?.getBoundingClientRect(),
          clientX,
          clientY,
        )
      )
        return false;
      return !!target && !contentRef.current?.contains(target);
    };
    const handlePointerDown = (e: PointerEvent) => {
      pointerDownOutsideRef.current = isOutside(
        e.target as Node | null,
        e.clientX,
        e.clientY,
      );
    };
    const handlePointerUp = (e: PointerEvent) => {
      const pressWasOutside = pointerDownOutsideRef.current;
      pointerDownOutsideRef.current = false;
      if (!pressWasOutside) return;
      // Only the topmost open modal dismisses on a backdrop click; a press inside (or on the
      // close button of) a modal stacked above this one must not close the one below.
      if (modalStack[modalStack.length - 1] !== modalId) return;
      if (isOutside(e.target as Node | null, e.clientX, e.clientY))
        requestClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      pointerDownOutsideRef.current = false;
    };
  }, [isOpen, requestClose, closeOnOutsideClick, modalId]);

  // The box is placed through `--modal-top`, centered on `anchorHeight`: the height its first frame
  // had (read when the box mounts, in the commit, before paint), then the height each slide ends
  // on. A body that changes height slides both edges to the new center until a pointerdown or
  // keydown lands inside the box; after that the top stays put and the change happens at the
  // bottom edge, unless the box reaches it with room above. A viewport resize re-centers at once.
  // Every state and event is in the table in docs/modals.md ("The states of a slide").
  const [anchorHeight, setAnchorHeight] = useState<number | null>(null);
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const anchorContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    setContentNode(node);
    setAnchorHeight(node ? layoutHeight(node) : null);
  }, []);
  const anchored = anchorHeight !== null;

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (anchorHeight === null && node) setAnchorHeight(layoutHeight(node));
  }, [anchorHeight]);

  // NOTE: a reopen that catches the box still fading out gets the same node back, with the pin of
  // the last opening and, if it closed mid-slide, frozen inline values. It starts fresh whatever
  // state it closed in: the inline values come off and the pin is dropped, so the renders that
  // follow (before paint) center it and measure the new pin. Keyed on "retained", not "frozen": a
  // box closed while idle that a touch had pinned off center comes back with a matching baseline.
  useLayoutEffect(() => {
    const node = contentNode;
    if (!isOpen || !node || node.dataset.modalRetained === undefined) return;
    delete node.dataset.modalRetained;
    node.style.transition = "none";
    node.style.height = "";
    node.style.top = "";
    node.style.maxHeight = "";
    node.style.overflow = "";
    setAnchorHeight(null);
    void node.offsetTop;
    node.style.transition = "";
  }, [isOpen, contentNode]);

  // What a change of height is compared against and a slide starts from: the height and top of
  // the frame painted before the change. Read from the node, never carried next to the pin, and
  // only after the commit that set the pin (this layout effect, or right after a handler's own
  // flushSync): a height kept in a closure is read at a moment React or the DOM has not caught up.
  const baselineRef = useRef<{
    height: number;
    top: number;
    generation: number;
  } | null>(null);
  useLayoutEffect(() => {
    const node = contentNode;
    if (!isOpen || !node || anchorHeight === null) return;
    baselineRef.current = {
      height: layoutHeight(node),
      top: layoutTop(node),
      generation: openGeneration,
    };
  }, [isOpen, anchorHeight, openGeneration, contentNode]);

  // NOTE: a layout effect, so the observer is attached before the first frame is painted. Four
  // invariants hold on every path: nothing moves under a pointer pressed inside the box or under
  // the caret once the person typed; measuring changes nothing visible (the natural height is only
  // read when the height changed or the box is cut, and every scroll position is kept); every
  // report is checked for a box cut at the bottom edge, the first one included; and nothing
  // painted moves between the last frame of a slide and the unmount (a close freezes it).
  useLayoutEffect(() => {
    const node = contentNode;
    if (!isOpen || !node) return;
    const remPx = () =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
      16;
    const center = (height: number) =>
      `max(1rem, calc(50dvh - ${height / 2}px))`;
    const reducedMotion = () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A fixed element 100dvh tall: the height `dvh` resolves to, which the pin and the max-height
    // are computed against. innerHeight can differ from it by half a pixel, and a center computed
    // from it would disagree with where CSS put the box, which the off-center check below would
    // read as a reason to slide again forever.
    const viewport = document.createElement("div");
    viewport.setAttribute("aria-hidden", "true");
    viewport.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:100dvh;visibility:hidden;pointer-events:none";
    document.body.appendChild(viewport);
    const viewportHeight = () => {
      const height = viewport.getBoundingClientRect().height;
      return height > 0 ? height : window.innerHeight;
    };
    // Read from the node, after a commit or in the observer's callback (after layout): what the
    // frame about to be painted shows.
    const sample = () => {
      baselineRef.current = {
        height: layoutHeight(node),
        top: layoutTop(node),
        generation: baselineRef.current?.generation ?? 0,
      };
    };
    let interacted = false;
    let pressed = false;
    let deferred = false;
    // A slide frozen by a press, held at its height until the pointer is up.
    let held = false;
    let slide: {
      to: number;
      timer: ReturnType<typeof setTimeout>;
      onEnd: (e: TransitionEvent) => void;
    } | null = null;
    let frame = 0;
    // The frame after a pointerup, a pointercancel or a keystroke, when a held box lets its height
    // go or a deferred check runs.
    let liftFrame = 0;
    let observer: ResizeObserver | null = null;

    const clearInline = () => {
      node.style.transition = "";
      node.style.height = "";
      node.style.top = "";
      node.style.maxHeight = "";
      node.style.overflow = "";
    };
    // Observing again delivers the size the node has at that moment, so a change made while it was
    // unobserved is picked up then. Never from inside the observer's own callback: an observation
    // added there is not deeper than the one being delivered, so the browser skips it and reports
    // "ResizeObserver loop completed with undelivered notifications".
    const observeAgain = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => observer?.observe(node));
    };
    // Where a running slide was last painted. Each frame reads its value in requestAnimationFrame
    // and takes it as painted only when a message posted from there arrives, which is after that
    // frame's paint: Chromium can deliver a pointerdown after the next frame's animations were
    // updated and before it is painted, and the computed value is then one frame ahead of what the
    // person pressed on.
    let lastPainted = { top: 0, height: 0 };
    let pending: { top: number; height: number } | null = null;
    let slideFrame = 0;
    const painting =
      typeof MessageChannel === "undefined" ? null : new MessageChannel();
    if (painting) {
      painting.port1.onmessage = () => {
        if (slide && pending) lastPainted = pending;
        pending = null;
      };
    }
    const trackSlide = () => {
      if (!slide) return;
      pending = { top: layoutTop(node), height: layoutHeight(node) };
      if (painting) painting.port2.postMessage(0);
      else lastPainted = pending;
      slideFrame = requestAnimationFrame(trackSlide);
    };
    const stopSlide = () => {
      if (!slide) return;
      cancelAnimationFrame(slideFrame);
      clearTimeout(slide.timer);
      node.removeEventListener("transitionend", slide.onEnd);
      slide = null;
    };
    const settle = () => {
      if (!slide) return;
      const { to } = slide;
      stopSlide();
      // NOTE: committed synchronously, so `--modal-top` already holds the new center when the
      // inline values come off and no frame sits in between.
      flushSync(() => setAnchorHeight(to));
      // NOTE: before the inline values come off: what is painted is the slide's end, and a body
      // that changed during the slide is a change from there, seen when it is observed again.
      sample();
      clearInline();
      observer?.observe(node);
    };
    // Drops a slide or a held box without settling it, for a resize or a close.
    const cancel = () => {
      const unobserved = slide !== null || held;
      stopSlide();
      held = false;
      clearInline();
      return unobserved;
    };
    // The pin is a height the top is centered on, so the height whose center is the painted top
    // keeps the box where it is.
    const pinTopAt = (top: number) => {
      flushSync(() => setAnchorHeight(Math.max(0, viewportHeight() - 2 * top)));
    };
    // Stops a running slide where it is painted: the last painted top and height are written back
    // with no transition and the pin moves to that top. The height stays inline while the pointer
    // is down, since letting it go moves the bottom edge, where a footer button may be under it.
    const freeze = () => {
      if (!slide) return;
      stopSlide();
      const { top, height } = lastPainted;
      node.style.transition = "none";
      node.style.top = `${top}px`;
      node.style.height = `${height}px`;
      void node.offsetTop;
      pinTopAt(top);
      node.style.top = "";
      sample();
      held = true;
      // NOTE: a keystroke lets the height go on the next frame, for the reason given in
      // `afterTheGesture`: the Escape that closes the dialog is one.
      if (!pressed) afterTheGesture();
    };
    const release = () => {
      if (!held) return;
      held = false;
      clearInline();
      observer?.observe(node);
    };
    // Every scrolled element inside the box, the box included, with where it is scrolled to.
    const scrollPositions = () => {
      const scrolled: [Element, number, number][] = [];
      for (const element of [node, ...node.querySelectorAll("*")]) {
        if (element.scrollTop !== 0 || element.scrollLeft !== 0) {
          scrolled.push([element, element.scrollTop, element.scrollLeft]);
        }
      }
      return scrolled;
    };
    // Lifting `max-height` grows the scroll area to its content and clamps its scrollTop to 0, and
    // restoring the cap does not bring it back, so every scroll position is put back by hand.
    const naturalHeight = () => {
      const scrolled = scrollPositions();
      node.style.maxHeight = "none";
      const natural = layoutHeight(node);
      node.style.maxHeight = "";
      for (const [element, top, left] of scrolled) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
      return natural;
    };
    // Moves the box from where it was painted to the center of `to`. Runs with the node unobserved,
    // inside the observer's callback (after layout, before paint) or on the frame after a pointerup,
    // so the frame about to be painted is the starting one.
    const moveToCenter = (from: number, to: number) => {
      if (reducedMotion()) {
        // NOTE: the global reduced-motion rule shortens every transition to 0.01ms instead of
        // removing it, and `transition-property` defaults to `all`, so `top` would still paint a
        // frame at the old place. No transition while the new center is applied.
        node.style.transition = "none";
        flushSync(() => setAnchorHeight(to));
        void node.offsetTop;
        node.style.transition = "";
        sample();
        observeAgain();
        return;
      }
      const fromTop = layoutTop(node);
      node.style.overflow = "hidden";
      node.style.maxHeight = "none";
      node.style.transition = "none";
      node.style.height = `${from}px`;
      node.style.top = `${fromTop}px`;
      void node.offsetHeight;
      const easing = "260ms cubic-bezier(0.2, 0, 0, 1)";
      node.style.transition = `top ${easing}, height ${easing}`;
      node.style.height = `${to}px`;
      node.style.top = center(to);
      // A slide at the same height has no `height` transition to end.
      const last = Math.abs(to - from) < SUBPIXEL ? "top" : "height";
      const onEnd = (e: TransitionEvent) => {
        if (e.target === node && e.propertyName === last) settle();
      };
      node.addEventListener("transitionend", onEnd);
      // NOTE: a transition that never ends (a hidden tab, an engine that skips a zero-length one)
      // must not leave the inline values in place.
      slide = { to, onEnd, timer: setTimeout(settle, 400) };
      lastPainted = { top: fromTop, height: from };
      slideFrame = requestAnimationFrame(trackSlide);
    };
    const check = () => {
      const base = baselineRef.current;
      if (slide || held || !base) return;
      const edge = remPx();
      const viewHeight = viewportHeight();
      const current = layoutHeight(node);
      const top = layoutTop(node);
      const cutAtTheBottom =
        top > edge + SUBPIXEL && top + current >= viewHeight - edge - SUBPIXEL;
      // An untouched box is centered on the height it has, so where it is painted is checked against
      // that, not only its height against the baseline's: a body that changes height in its own
      // mount effect commits after the pin was measured and before the baseline is read, so the
      // baseline matches the new height while the box is centered on the old one. Every baseline is
      // followed by a report, so this is where a pin that disagrees with the height is caught.
      const offCenter =
        !interacted &&
        Math.abs(top - Math.max(edge, (viewHeight - current) / 2)) >= SUBPIXEL;
      // NOTE: a report of a change of width only.
      if (
        Math.abs(current - base.height) < SUBPIXEL &&
        !cutAtTheBottom &&
        !offCenter
      ) {
        return;
      }
      if (interacted && !cutAtTheBottom) {
        sample();
        return;
      }
      if (interacted && pressed) {
        sample();
        deferred = true;
        return;
      }
      const to = Math.min(naturalHeight(), viewHeight - 2 * edge);
      // A slide whose end is where the box is painted (the same height at the same top) moves
      // nothing and is never started. A cut box at the same height still moves: its top is off.
      const targetTop = Math.max(edge, (viewHeight - to) / 2);
      if (
        Math.abs(to - base.height) < SUBPIXEL &&
        Math.abs(targetTop - top) < SUBPIXEL
      ) {
        sample();
        return;
      }
      observer?.unobserve(node);
      moveToCenter(base.height, to);
    };
    observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(node);

    const touched = (e: Event) => {
      if (!(e.target instanceof Node && node.contains(e.target))) return;
      interacted = true;
      if (e.type === "pointerdown") pressed = true;
      freeze();
    };
    // On the next frame, not in the pointerup or keydown itself: the `click` that follows the
    // pointerup, and the close it or an Escape makes (committed in a microtask), come before it, and
    // a close must still find the box held to keep it where it is through the exit animation. A new
    // press in between keeps it held.
    const afterTheGesture = () => {
      cancelAnimationFrame(liftFrame);
      liftFrame = requestAnimationFrame(() => {
        if (pressed) return;
        if (held) {
          release();
          return;
        }
        if (deferred) {
          deferred = false;
          check();
        }
      });
    };
    const lifted = () => {
      if (!pressed) return;
      pressed = false;
      afterTheGesture();
    };
    document.addEventListener("pointerdown", touched, true);
    document.addEventListener("keydown", touched, true);
    document.addEventListener("pointerup", lifted, true);
    document.addEventListener("pointercancel", lifted, true);
    // Synchronous, so the observer's next report already sees the box centered on its own height
    // and does not read the re-centering as a change of height to slide. Without a transition, for
    // the reason given in moveToCenter.
    const reanchor = () => {
      const unobserved = cancel();
      node.style.transition = "none";
      flushSync(() => setAnchorHeight(null));
      node.style.transition = "";
      sample();
      if (unobserved) observer?.observe(node);
    };
    window.addEventListener("resize", reanchor);
    // Leaves a sliding or held box where it is painted, for the exit animation: Radix keeps the box
    // on screen while it fades out, and clearing the inline values there snaps it back to the old
    // pin and to its natural height.
    const freezeForExit = () => {
      if (!slide && !held) return;
      const sliding = slide !== null;
      stopSlide();
      held = false;
      const { top, height } = sliding
        ? lastPainted
        : { top: layoutTop(node), height: layoutHeight(node) };
      node.style.transition = "none";
      node.style.maxHeight = "none";
      node.style.overflow = "hidden";
      node.style.top = `${top}px`;
      node.style.height = `${height}px`;
    };
    return () => {
      viewport.remove();
      freezeForExit();
      // NOTE: whatever it closed in; read by the reset above if it reopens.
      node.dataset.modalRetained = "";
      cancelAnimationFrame(frame);
      cancelAnimationFrame(liftFrame);
      painting?.port1.close();
      observer?.disconnect();
      document.removeEventListener("pointerdown", touched, true);
      document.removeEventListener("keydown", touched, true);
      document.removeEventListener("pointerup", lifted, true);
      document.removeEventListener("pointercancel", lifted, true);
      window.removeEventListener("resize", reanchor);
    };
  }, [isOpen, contentNode]);

  return (
    <ModalControllerContext.Provider value={modal}>
      <ModalCloseContext.Provider value={requestClose}>
        <DialogPrimitive.Root
          open={isOpen}
          onOpenChange={(open) => {
            if (!open) requestClose();
          }}
        >
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay
              style={overlayStyle}
              className={cn(
                "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 bg-overlay data-[state=closed]:animate-out data-[state=open]:animate-in fixed inset-0",
                stackLevel === 0 && "z-(--z-modal-overlay)",
              )}
            />
            <DialogPrimitive.Content
              style={contentStyle}
              // Suppress Radix's own outside-dismiss entirely; our paired
              // pointerdown/pointerup listeners own the decision (Radix dispatches this
              // callback deferred, after pointerup, which is too late to gate the release).
              onPointerDownOutside={(e) => {
                e.preventDefault();
              }}
              // NOTE: a control INSIDE the dialog may own Escape, such as the code editor's completion popup,
              // where closing the dialog on the same press would offer to discard the body. The control cannot
              // stop the event, because Radix listens on `document` in the CAPTURE phase and runs first, so it
              // declares a claim and the press is cancelled here.
              onEscapeKeyDown={(e) => {
                if (handOverEscape(e.target)) e.preventDefault();
              }}
              // NOTE: Radix Dialog warns in dev when Content has no Description
              // child. Passing `undefined` explicitly acknowledges the absence so
              // the warning is suppressed; when `description` is set below, Radix
              // auto-wires the real id from the Description element's context.
              aria-describedby={undefined}
              // NOTE: when `title` renders a <DialogPrimitive.Title>, Radix wires
              // `aria-labelledby` from it automatically. When no title is
              // provided, `ariaLabel` gives the dialog an accessible name.
              aria-label={!title && ariaLabel ? ariaLabel : undefined}
              // NOTE: a full-viewport layer that holds the box. It centers nothing: the box is placed
              // through `--modal-top` (docs/modals.md, "Centering"). It carries the fade, so Radix's
              // Presence, which watches this node's own animation, still plays the exit.
              className={cn(
                "group data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in fixed inset-0 focus:outline-none",
                stackLevel === 0 && "z-(--z-modal)",
              )}
            >
              {/* The visible modal box: contentRef, the outside-click geometry and the slide all
                  read it, never the full-screen Content. `origin-top` keeps the entry zoom from
                  moving the top edge the first frame was centered at. */}
              <div
                ref={anchorContent}
                className={cn(
                  "border-border bg-bg-secondary group-data-[state=closed]:zoom-out-95 group-data-[state=open]:zoom-in-95 group-data-[state=closed]:animate-out group-data-[state=open]:animate-in absolute left-1/2 flex w-[calc(100vw-2rem)] origin-top -translate-x-1/2 flex-col rounded-xl border",
                  {
                    "top-[50dvh] max-h-[calc(100dvh-2rem)] -translate-y-1/2":
                      !anchored,
                    "top-(--modal-top) max-h-[calc(100dvh-var(--modal-top)-1rem)]":
                      anchored,
                  },
                  sizeClasses[size],
                  className,
                )}
                style={
                  anchored
                    ? ({
                        "--modal-top": `max(1rem, calc(50dvh - ${anchorHeight / 2}px))`,
                      } as CSSProperties)
                    : undefined
                }
              >
                {title && (
                  <div className="border-border flex shrink-0 items-center justify-between border-b px-6 py-4">
                    <DialogPrimitive.Title className="text-text-primary text-xl font-semibold">
                      {title}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Close
                      disabled={busy}
                      // t('common.close', 'Close')
                      aria-label={t("common.close", "Close")}
                      className="text-text-muted hover:bg-bg-tertiary hover:text-text-primary rounded-lg p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <X className="h-5 w-5" aria-hidden="true" />
                    </DialogPrimitive.Close>
                  </div>
                )}
                {description && (
                  <DialogPrimitive.Description className="text-text-secondary px-6 pt-4 text-sm">
                    {description}
                  </DialogPrimitive.Description>
                )}
                {/* A number out of range in the body holds the footer's Save (<RangeHeld>). */}
                <RangeHolds>
                  <div
                    className={cn("flex-1 overflow-y-auto", {
                      "px-6 py-4": !!title,
                    })}
                  >
                    <ModalDirtyContext.Provider value={dirtyCtx}>
                      {children}
                    </ModalDirtyContext.Provider>
                  </div>
                  {footer && (
                    <div className="border-border shrink-0 border-t px-6 py-4">
                      {footer}
                    </div>
                  )}
                </RangeHolds>
              </div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <DiscardDialog
          open={discardOpen}
          depth={stackLevel + 1}
          onKeep={() => setDiscardOpen(false)}
          onDiscard={() => {
            setDiscardOpen(false);
            modal.close();
          }}
        />
      </ModalCloseContext.Provider>
    </ModalControllerContext.Provider>
  );
}
