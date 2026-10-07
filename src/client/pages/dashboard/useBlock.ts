import { useCallback, useEffect, useRef, useState } from "react";

// One block's data, loaded on its own: a slow or failing block does not hold or blank the others.
// Each load takes a sequence number and only the latest one's answer is kept, so switching the
// filter twice quickly cannot leave the first view's numbers on screen. `key` is what the load
// depends on (the serialized query): a new key drops the previous view's data at once, so nothing of
// the old filter stays on screen (or clickable) while the new one loads; `reload` keeps it, since a
// refresh of the same view is the same numbers until the new ones arrive.
export function useBlock<T>(
  key: string,
  load: () => Promise<{ data: T | null; status?: number | null }>,
): {
  data: T | null;
  loading: boolean;
  error: boolean;
  status: number | null;
  reload: () => void;
} {
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: boolean;
    status: number | null;
  }>({ data: null, loading: true, error: false, status: null });
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const run = useCallback((fresh: boolean) => {
    const mine = ++seq.current;
    setState((s) => ({
      data: fresh ? null : s.data,
      loading: true,
      error: false,
      status: null,
    }));
    loadRef
      .current()
      .then((res) => {
        if (mine !== seq.current) return;
        setState({
          data: res.data,
          loading: false,
          error: res.data === null,
          status: res.status ?? null,
        });
      })
      .catch(() => {
        if (mine !== seq.current) return;
        setState({ data: null, loading: false, error: true, status: null });
      });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the reload trigger; the loader is read through a ref.
  useEffect(() => {
    run(true);
  }, [key, run]);
  const reload = useCallback(() => run(false), [run]);
  return { ...state, reload };
}
