import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  SIDEBAR_COLLAPSE_SNAP,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebar,
} from "@/client/contexts/SidebarContext";

const KEYBOARD_STEP = 16;
// Matches the aside's `duration-200` in Sidebar.tsx. While dragging, the
// width transition is off so the edge tracks the pointer; crossing the collapse
// snap is the one jump the drag cannot follow, so the transition is switched
// back on for exactly this long around it.
const SNAP_TRANSITION_MS = 200;

export function SidebarResizer() {
  const { t } = useTranslation();
  const { collapsed, setCollapsed, toggleCollapsed, width, setWidth } =
    useSidebar();
  const rafId = useRef<number | null>(null);
  const pendingX = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const dragStartWidthRef = useRef<number | null>(null);
  const dragStartCollapsedRef = useRef<boolean>(false);
  // When setPointerCapture throws (older Safari), we wire up
  // document-level listeners instead so the drag still tracks the pointer
  // after it leaves the 2px grip. This ref holds the detach function until
  // the drag ends.
  const documentListenersCleanupRef = useRef<(() => void) | null>(null);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const snapTimeoutRef = useRef<number | null>(null);

  const cancelRaf = useCallback(() => {
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
  }, []);

  // NOTE: cancel pending rAF on unmount
  useEffect(() => () => cancelRaf(), [cancelRaf]);

  // NOTE: defensive cleanup so a mid-drag unmount does not leave the body
  // in a resizing state (locked cursor, disabled user-select) and no leaked
  // document listeners from the Safari fallback path.
  useEffect(
    () => () => {
      if (snapTimeoutRef.current != null) {
        window.clearTimeout(snapTimeoutRef.current);
      }
      delete document.body.dataset.sidebarSnapping;
      delete document.body.dataset.resizingSidebar;
      documentListenersCleanupRef.current?.();
    },
    [],
  );

  const markSnapping = useCallback(() => {
    document.body.dataset.sidebarSnapping = "true";
    if (snapTimeoutRef.current != null) {
      window.clearTimeout(snapTimeoutRef.current);
    }
    snapTimeoutRef.current = window.setTimeout(() => {
      snapTimeoutRef.current = null;
      delete document.body.dataset.sidebarSnapping;
    }, SNAP_TRANSITION_MS);
  }, []);

  const applyX = useCallback(
    (x: number) => {
      const nextCollapsed = x < SIDEBAR_COLLAPSE_SNAP;
      if (nextCollapsed !== collapsedRef.current) markSnapping();
      if (nextCollapsed) {
        setCollapsed(true);
      } else {
        setCollapsed(false);
        setWidth(x);
      }
    },
    [markSnapping, setCollapsed, setWidth],
  );

  const endDrag = useCallback(
    (element: HTMLDivElement | null, pointerId: number) => {
      if (element) {
        try {
          element.releasePointerCapture(pointerId);
        } catch {
          // NOTE: Ignore if the capture was already released or never held.
        }
      }
      documentListenersCleanupRef.current?.();
      pointerIdRef.current = null;
      dragStartWidthRef.current = null;
      dragStartCollapsedRef.current = false;
      delete document.body.dataset.resizingSidebar;
      cancelRaf();
      pendingX.current = null;
    },
    [cancelRaf],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      pointerIdRef.current = event.pointerId;
      dragStartWidthRef.current = width;
      dragStartCollapsedRef.current = collapsed;

      let captured = false;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
        captured = true;
      } catch {
        // NOTE: older Safari throws on setPointerCapture; fall back to
        // document listeners below so the drag still tracks the pointer.
      }

      if (!captured) {
        const onMove = (ev: PointerEvent) => {
          if (pointerIdRef.current !== ev.pointerId) return;
          pendingX.current = ev.clientX;
          if (rafId.current != null) return;
          rafId.current = requestAnimationFrame(() => {
            rafId.current = null;
            if (pendingX.current != null) applyX(pendingX.current);
          });
        };
        const onEnd = (ev: PointerEvent) => {
          if (pointerIdRef.current !== ev.pointerId) return;
          const pending = pendingX.current;
          endDrag(null, ev.pointerId);
          if (pending != null) applyX(pending);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onEnd);
        document.addEventListener("pointercancel", onEnd);
        documentListenersCleanupRef.current = () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onEnd);
          document.removeEventListener("pointercancel", onEnd);
          documentListenersCleanupRef.current = null;
        };
      }

      document.body.dataset.resizingSidebar = "true";
    },
    [applyX, collapsed, endDrag, width],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      pendingX.current = event.clientX;
      if (rafId.current != null) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (pendingX.current != null) applyX(pendingX.current);
      });
    },
    [applyX],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      const pending = pendingX.current;
      endDrag(event.currentTarget, event.pointerId);
      if (pending != null) applyX(pending);
    },
    [applyX, endDrag],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      endDrag(event.currentTarget, event.pointerId);
    },
    [endDrag],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // NOTE: ignore auto-repeat so held keys do not spam setWidth.
      if (event.repeat) return;

      if (event.key === "Escape") {
        if (pointerIdRef.current == null) return;
        event.preventDefault();
        const startWidth = dragStartWidthRef.current;
        const startCollapsed = dragStartCollapsedRef.current;
        endDrag(event.currentTarget, pointerIdRef.current);
        if (startWidth != null) {
          setCollapsed(startCollapsed);
          // NOTE: always restore startWidth so a drag-from-collapsed that
          // briefly expanded (via applyX) does not leave the temporary
          // dragged width as the remembered expanded width.
          setWidth(startWidth);
        }
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleCollapsed();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (collapsed) return;
        const next = width - KEYBOARD_STEP;
        if (next < SIDEBAR_COLLAPSE_SNAP) setCollapsed(true);
        else setWidth(next);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (collapsed) {
          setCollapsed(false);
          setWidth(SIDEBAR_MIN_WIDTH);
        } else {
          setWidth(width + KEYBOARD_STEP);
        }
      } else if (event.key === "Home") {
        event.preventDefault();
        setCollapsed(false);
        setWidth(SIDEBAR_MIN_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        setCollapsed(false);
        setWidth(SIDEBAR_MAX_WIDTH);
      }
    },
    [collapsed, endDrag, setCollapsed, setWidth, toggleCollapsed, width],
  );

  // t('nav.collapsed', 'Collapsed')
  const collapsedValueText = t("nav.collapsed", "Collapsed");

  return (
    // biome-ignore lint/a11y/useSemanticElements: interactive resize handle needs a focusable div with role=separator (WAI-ARIA Window Splitter pattern); <hr> is non-interactive
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("nav.resizeSidebar", "Resize sidebar")}
      aria-valuenow={collapsed ? SIDEBAR_MIN_WIDTH : width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuetext={collapsed ? collapsedValueText : undefined}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
      className="group absolute top-0 -right-1 z-(--z-sidebar) flex h-full w-2 cursor-col-resize touch-none items-stretch justify-center outline-none"
    >
      {/* The highlight is inset by the content panel's corner radius plus
          its vertical margin, so it traces the panel's straight left edge
          instead of running past the rounded corners. */}
      <span className="my-[calc(var(--radius-xl)+var(--spacing)*2)] w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
    </div>
  );
}
