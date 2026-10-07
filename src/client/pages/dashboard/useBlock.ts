import { useCallback, useEffect, useRef, useState } from "react";

// One block's data, loaded on its own: a slow or failing block does not hold or blank the others.
// Each load takes a sequence number and only the latest one's answer is kept, so switching the
// filter twice quickly cannot leave the first view's numbers on screen. `key` is what the load
// depends on (the serialized query); a new key reloads.
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
  const run = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: false, status: null }));
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
    run();
  }, [key, run]);
  return { ...state, reload: run };
}
