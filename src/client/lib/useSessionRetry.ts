import { useEffect } from "react";
import { useAuth } from "@/client/contexts/AuthContext";

// How often a screen waiting on `/auth/me` asks again.
export const SESSION_RETRY_MS = 2_000;

// A fresh login refreshes the session ONCE, and a screen that waits on what that refresh brings (the
// membership list, the role held in the selected tenant) would otherwise wait for good after a blip
// (issue #756, review rounds 7 and 8). While `waiting`, this asks again until the answer lands, and
// the screen stops waiting the moment it does.
export function useSessionRetry(waiting: boolean): void {
  const { refresh } = useAuth();
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void refresh();
    }, SESSION_RETRY_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);
}
