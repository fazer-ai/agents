import { useCallback, useSyncExternalStore } from "react";

// For layout that has to change structure, not just style, at a breakpoint. When CSS can do it,
// use CSS: this re-renders on every crossing.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", listener);
      return () => mql.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
