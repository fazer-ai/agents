import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/client/lib/api";

export type ProactiveBreakerStatus = NonNullable<
  Awaited<
    ReturnType<
      (typeof api.api.v1)["tenant-settings"]["proactive-breaker"]["get"]
    >
  >["data"]
>["proactiveBreaker"];

interface ProactiveBreakerContextValue {
  status: ProactiveBreakerStatus | null;
  // True once a read failed and none has succeeded since.
  failed: boolean;
  refresh: () => Promise<void>;
  // Takes a status a write already returned, so the banner and the card agree at once.
  set: (next: ProactiveBreakerStatus) => void;
}

const ProactiveBreakerContext =
  createContext<ProactiveBreakerContextValue | null>(null);

// How often the shell asks whether the account's proactive breaker tripped. A trip stops every agent's
// proactive messages until someone resumes, so the banner has to appear without a reload, but a
// minute of delay costs nothing that the alert channels do not already cover.
const POLL_MS = 60_000;

// The account breaker's state, read once for the whole shell: the banner on every page and the card
// in Components > Advanced show the same answer, and a resume from either updates both.
export function ProactiveBreakerProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [status, setStatus] = useState<ProactiveBreakerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // A read that settles after a newer one is dropped, so a slow poll cannot undo a resume.
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { data, error } =
        await api.api.v1["tenant-settings"]["proactive-breaker"].get();
      if (error || !data) throw error ?? new Error("no data");
      if (mine !== seq.current) return;
      setStatus(data.proactiveBreaker);
      setFailed(false);
    } catch {
      if (mine !== seq.current) return;
      setFailed(true);
    }
  }, []);

  const set = useCallback((next: ProactiveBreakerStatus) => {
    seq.current++;
    setStatus(next);
    setFailed(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const value = useMemo(
    () => ({ status, failed, refresh, set }),
    [status, failed, refresh, set],
  );
  return (
    <ProactiveBreakerContext.Provider value={value}>
      {children}
    </ProactiveBreakerContext.Provider>
  );
}

export function useProactiveBreaker(): ProactiveBreakerContextValue {
  const ctx = useContext(ProactiveBreakerContext);
  if (!ctx)
    throw new Error(
      "useProactiveBreaker must be used inside ProactiveBreakerProvider",
    );
  return ctx;
}
