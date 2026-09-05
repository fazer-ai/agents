import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useBackGuard, useBeforeUnload } from "@/client/lib/unsavedGuard";
import { cn } from "@/client/lib/utils";
import { Button } from "./Button";
import { DiscardDialog } from "./DiscardDialog";
import { handOverEscape } from "./escapeClaim";

// NOTE: stacked modals resolve their z-index at runtime via
// `calc(var(--z-modal) + level * step)` — `level` is the modal's position in the open-stack
// (see below) — so the base value stays defined in one place (public/index.css). Each level adds
// MODAL_DEPTH_STEP to the content; the overlay sits one below its content so it dims the modal
// beneath without escaping to the next layer above. At level 0 the Tailwind z-token classes below
// are used unchanged, which preserves the 10-unit gap between --z-modal-overlay (70) and
// --z-modal (80). At level >0 the gap between overlay and content collapses to 1; this is only a
// problem if a new z-indexed layer is ever introduced between a content and its own overlay,
// which does not happen with the current token set.
const MODAL_DEPTH_STEP = 2;
// NOTE: with base 80 and step 2, level 5 reaches --z-toast (90). Warn before
// the collision so the conflict does not go silently wrong.
const MODAL_MAX_DEPTH = 4;

// NOTE: the open modals, in open order (module-level so every <Modal> shares one stack). It
// drives two things Radix's per-dialog primitives and our document-level dismissal can't do on
// their own for SIBLING modals (ones rendered at the same React position, e.g. a page that mounts
// several <Modal> next to each other and opens them in sequence):
//   1. Dismissal stacking: only the TOPMOST open modal reacts to a backdrop click. Our
//      pointerdown/pointerup listeners run on `document` and, unlike Radix's DismissableLayer, have
//      no stacking awareness — without this a click on an upper modal dismisses a lower one.
//   2. Overlay dimming / z-index: each modal's z derives from its position here, so a modal opened
//      later sits (with its dimming overlay one step below it) above every earlier one. Sibling
//      modals would otherwise share a z and their overlays could not dim each other.
// Reactive via useSyncExternalStore so opening/closing one re-renders the others to restack.
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

// NOTE: Wrap both branches in tuples to stop TS from distributing over union
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

// NOTE: Lets a modal body report whether it has unsaved changes. Each <Modal>
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

// NOTE: Controller API — state lifted from the modal wrapper into a hook the
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

// NOTE: the guard-aware close. Footer buttons rendered inside a <Modal> (e.g. a
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

// NOTE: Convenience for the common "init state when the modal opens" pattern.
// Fires `effect` each time the passed controller's `isOpen` transitions from
// false to true, and runs the optional cleanup when it transitions back to
// false. Takes the controller directly (not the boolean) because this hook
// is typically called in the wrapper component *before* `<Modal>` mounts its
// `ModalControllerContext.Provider`, so it cannot read the controller from
// context the way `useModal` does. The effect closure is refreshed on every
// render, so it always sees the latest props and state without re-firing
// mid-open (which would clobber user edits on an unrelated prop change). For
// behavior that must react to changes while the modal is open, use
// `useEffect` directly.
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
  // unaffected.
  onCloseRequest?: () => void;
  // NOTE: when true, a user-driven close (Esc/outside/X/Back) is intercepted
  // with a "discard changes?" confirmation, and the browser guards (native
  // unload prompt + Back-button trap) are armed while the modal is open. Pass
  // the form's dirty flag. This is the ergonomic path when the form state lives
  // in the wrapper (outside the <Modal> subtree). A descendant body component
  // can instead call `useUnsavedChanges(isDirty)`; both are OR-ed together.
  // Takes precedence over `onCloseRequest` while dirty.
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

  // Single funnel for every user-driven close (Esc, outside click, X, Back).
  // Dirty → show the discard confirm; otherwise run the custom onCloseRequest
  // (if any) or close. Programmatic modal.close() from the parent bypasses this.
  const requestClose = useCallback(() => {
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
  useBackGuard(guardActive, requestClose);
  // NOTE: stackLevel (from the open-stack, already capped at MODAL_MAX_DEPTH) drives the z-index so
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
  // NOTE: Radix closes on pointerdown-outside by default, which closes mid-drag
  // (e.g. a text selection released outside the modal). We instead close only when
  // BOTH the press and the release land outside the content. This is driven by our own
  // real pointerdown/pointerup document listeners (below), NOT Radix's
  // `onPointerDownOutside` — Radix dispatches that callback AFTER `pointerup` (deferred
  // to the `click`), so a latch set there is always one gesture stale: it dangles past
  // its own release and then fires on the NEXT click, closing the modal on an unrelated
  // press (e.g. re-opening a dropdown after interacting with it). This ref records, per
  // gesture, whether the pointerdown was outside.
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
                "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in",
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
              // A control INSIDE the dialog may own Escape. The code editor's completion popup is
              // the measured case: Escape is the standard key for dismissing a suggestion, and
              // closing the dialog on that same press asked the operator whether to discard the
              // body they were writing. It cannot stop the event itself, because Radix listens on
              // `document` in the CAPTURE phase and therefore runs first; `defaultPrevented` is
              // what it reads back, so the claim is declared and cancelled here.
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
              // Full-viewport flex container that CENTERS the panel below. Centering by flexbox
              // (not top-50% + translateY(-50%)) means the panel's position never depends on its
              // own height, so a modal whose body loads async no longer paints low then jumps to
              // center once the content grows. Content stays the direct Portal child, so Radix's
              // Presence still plays the exit animation; the zoom/fade run here and scale the
              // centered panel around the viewport center (identical look to the translate one).
              className={cn(
                "data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed inset-0 flex items-center justify-center p-4 focus:outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
                stackLevel === 0 && "z-(--z-modal)",
              )}
            >
              {/* The visible modal box. contentRef lives HERE (not on the full-screen Content) so
                  the outside-click geometry measures the panel, not the whole viewport. */}
              <div
                ref={contentRef}
                className={cn(
                  "flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-xl border border-border bg-bg-secondary",
                  sizeClasses[size],
                  className,
                )}
              >
                {title && (
                  <div className="flex shrink-0 items-center justify-between border-border border-b px-6 py-4">
                    <DialogPrimitive.Title className="font-semibold text-text-primary text-xl">
                      {title}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Close
                      // t('common.close', 'Close')
                      aria-label={t("common.close", "Close")}
                      className="rounded-lg p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      <X className="h-5 w-5" aria-hidden="true" />
                    </DialogPrimitive.Close>
                  </div>
                )}
                {description && (
                  <DialogPrimitive.Description className="px-6 pt-4 text-sm text-text-secondary">
                    {description}
                  </DialogPrimitive.Description>
                )}
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
                  <div className="shrink-0 border-border border-t px-6 py-4">
                    {footer}
                  </div>
                )}
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
