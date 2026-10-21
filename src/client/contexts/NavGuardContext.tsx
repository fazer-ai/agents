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
} from "react";
import { useNavigate } from "react-router";
import { DiscardDialog } from "@/client/components/DiscardDialog";
import {
  leaveViaBackTrap,
  sentinelOnTop,
  useBackGuard,
  useBeforeUnload,
} from "@/client/lib/unsavedGuard";

// App-wide guard for unsaved page changes, registered via `useNavGuard(dirty)`. While any page is
// dirty it intercepts every way out with the shared "discard changes?" confirm: in-app <a> clicks (a
// capture-phase listener that pre-empts react-router's handler), browser Back (the history sentinel
// in unsavedGuard) and refresh or tab-close (beforeunload). Programmatic state-losing actions (the
// tenant switch's full reload) go through `useConfirmLeave()`, since the native prompt can be
// canceled AFTER the side effect ran. In-page navigation that keeps the component mounted (the
// agent editor's tab bar) is deliberately NOT guarded. Modals have their own guard (Modal.tsx).

type Pending =
  | { kind: "href"; href: string }
  | { kind: "back" }
  | { kind: "fn"; run: () => void };

type NavGuardValue = {
  register: (id: string, dirty: boolean) => void;
  confirmLeave: (run: () => void) => void;
};

const NavGuardContext = createContext<NavGuardValue | null>(null);

export function NavGuardProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const dirtyIds = useRef<Set<string>>(new Set());
  const [active, setActive] = useState(false);
  const [pending, setPendingState] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const setPending = useCallback((p: Pending | null) => {
    pendingRef.current = p;
    setPendingState(p);
  }, []);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Carry out a leave the operator asked for.
  const leave = useCallback(
    (p: Pending) => {
      setPending(null);
      if (p.kind === "href")
        navigateRef.current(p.href, { replace: sentinelOnTop() });
      else if (p.kind === "back") leaveViaBackTrap();
      else p.run();
    },
    [setPending],
  );

  // A page that turns clean while the confirm is open (its save landed) has nothing left to discard,
  // so the leave goes ahead. It runs before the guards let go: the Back trap's own cleanup would
  // otherwise traverse as well, and land one entry past the page.
  const register = useCallback(
    (id: string, dirty: boolean) => {
      const ids = dirtyIds.current;
      if (dirty === ids.has(id)) return;
      if (dirty) ids.add(id);
      else ids.delete(id);
      const asked = pendingRef.current;
      if (ids.size === 0 && asked) leave(asked);
      setActive(ids.size > 0);
    },
    [leave],
  );

  const confirmLeave = useCallback(
    (run: () => void) => {
      // Read the ref (not `active` state) so this stays correct without being
      // re-created on every dirty toggle. Clean → run now; dirty → ask first.
      if (dirtyIds.current.size === 0) run();
      else setPending({ kind: "fn", run });
    },
    [setPending],
  );

  // Native refresh / tab-close prompt.
  useBeforeUnload(active);

  // Browser Back: the sentinel was already re-pushed by the trap, so just open
  // the confirm; `leaveViaBackTrap()` performs the real Back on discard.
  useBackGuard(active, () => setPending({ kind: "back" }));

  // In-app link clicks. Capture phase so we run before react-router's Link
  // handler, which bails on `defaultPrevented`.
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const target = anchor.getAttribute("target");
      if (anchor.hasAttribute("download") || (target && target !== "_self")) {
        return;
      }
      if (!anchor.getAttribute("href")) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      // Only guard same-origin in-app navigations to a different page. A same-document change
      // (only the hash differs — e.g. the editor's section-nav TOC anchors) is an in-page scroll,
      // not leaving the page, so it must not trip the discard confirm.
      if (url.origin !== window.location.origin) return;
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      )
        return;
      e.preventDefault();
      setPending({ kind: "href", href: url.pathname + url.search + url.hash });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [active, setPending]);

  const onKeep = () => setPending(null);
  const onDiscard = () => {
    if (pending) leave(pending);
  };

  const value = useMemo(
    () => ({ register, confirmLeave }),
    [register, confirmLeave],
  );

  return (
    <NavGuardContext.Provider value={value}>
      {children}
      <DiscardDialog
        open={pending !== null}
        depth={1}
        onKeep={onKeep}
        onDiscard={onDiscard}
      />
    </NavGuardContext.Provider>
  );
}

// Register a page's unsaved-changes flag with the app-wide guard. While set,
// leaving the page (sidebar/breadcrumb links, the browser Back button, a
// refresh or tab-close) prompts to discard. In-page navigation that keeps the
// component mounted (e.g. the agent editor's tab bar, where state survives) is
// deliberately NOT guarded. Outside a <NavGuardProvider> it is a no-op, so it
// is safe in tests that mount a page in isolation.
export function useNavGuard(dirty: boolean) {
  const ctx = useContext(NavGuardContext);
  const id = useId();
  useEffect(() => {
    ctx?.register(id, dirty);
  }, [ctx, id, dirty]);
  // Clear this page's bit when it unmounts.
  useEffect(() => () => ctx?.register(id, false), [ctx, id]);
}

// Wrap a programmatic, state-losing action (e.g. switching tenant, which does a
// full reload) so it is gated by the shared discard confirm when a page has
// unsaved changes, and runs straight through otherwise. Usable from any
// component; outside a <NavGuardProvider> it runs the action immediately.
export function useConfirmLeave() {
  const ctx = useContext(NavGuardContext);
  return useCallback(
    (run: () => void) => {
      if (ctx) ctx.confirmLeave(run);
      else run();
    },
    [ctx],
  );
}
