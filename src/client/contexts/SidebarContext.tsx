import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "react-router";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_DEFAULT_WIDTH = 256;
// A CSS length, not a number, so it follows the density setting. The collapsed rail is 16 spacing
// steps wide and every icon in it sits 6 steps from the edge (nav padding + item padding), which
// centers a 4-step icon at any density. The icons then never move while the rail animates.
export const SIDEBAR_COLLAPSED_WIDTH = "calc(var(--spacing) * 16)";
// Drags below MIN_WIDTH snap to collapsed; drags at or above MIN_WIDTH
// expand to the pointer position (clamped). Keeping the snap equal to
// MIN_WIDTH avoids a dead range (150..200) that would otherwise be stored and
// then clamped up on reload.
export const SIDEBAR_COLLAPSE_SNAP = SIDEBAR_MIN_WIDTH;

const COLLAPSED_STORAGE_KEY = "@app:sidebar-collapsed";
const WIDTH_STORAGE_KEY = "@app:sidebar-width";

interface SidebarContextType {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  toggleCollapsed: () => void;
  width: number;
  setWidth: (width: number) => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextType | null>(null);

function clampWidth(value: number): number {
  if (Number.isNaN(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

function getStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function getStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH;
    return clampWidth(Number.parseInt(raw, 10));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, String(value));
  } catch {
    // NOTE: Ignore localStorage errors
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState<boolean>(getStoredCollapsed);
  const [width, setWidthState] = useState<number>(getStoredWidth);
  const [mobileOpen, setMobileOpen] = useState(false);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    writeCollapsed(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }, []);

  const setWidth = useCallback((next: number) => {
    setWidthState(clampWidth(next));
  }, []);

  // NOTE: debounce width persistence so pointer-driven resizes (fired per
  // rAF) do not block on synchronous localStorage writes every frame.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      try {
        localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
      } catch {
        // NOTE: Ignore localStorage errors
      }
    }, 150);
    return () => window.clearTimeout(timeoutId);
  }, [width]);

  const { pathname } = useLocation();
  // NOTE: close the mobile drawer on in-app navigation. The pathname is the
  // trigger, not an input to the effect body, hence the lint suppression.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is a route-change trigger
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // NOTE: close the mobile drawer when the viewport crosses into the desktop
  // breakpoint (md, 768px). Without this the Radix dialog stays mounted under
  // the desktop sidebar if the user resizes or rotates after opening it.
  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setMobileOpen(false);
    };
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  const value = useMemo(
    () => ({
      collapsed,
      setCollapsed,
      toggleCollapsed,
      width,
      setWidth,
      mobileOpen,
      setMobileOpen,
    }),
    [collapsed, setCollapsed, toggleCollapsed, width, setWidth, mobileOpen],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}
