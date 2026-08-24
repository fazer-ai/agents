import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { mediaFetch } from "@/client/lib/media";

// Debounced PDF preview of a template draft, as a blob URL.
//
// Deliberately NOT useMediaObjectUrl. That hook retries a 404 with backoff, which is right for a
// WhatsApp voice note that lands a moment after its message and wrong here: a preview failure is a
// validation error the operator has to READ, and retrying it four times over seven seconds only
// delays the message that says which block is broken. What is reused is the discipline that hook
// exists for — revoke the previous URL, revoke on unmount — because a blob URL that is never revoked
// pins its bytes for the life of the tab, and this one is re-minted on every keystroke.

export interface DocumentPreviewState {
  url: string | null;
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 600;

export function useDocumentPreview(
  draft: Record<string, unknown> | null,
  // Which EDITING SESSION this preview belongs to — one per modal open, not one per template. When
  // it changes the previous PDF is dropped synchronously: the request is debounced by 600 ms, so
  // without this the modal shows the last session's document under the current form for at least
  // that long, and an operator who cancels and reopens the SAME template reads a preview of the
  // edits they just discarded.
  //
  // Required, and a number, so the resource id cannot be passed here by mistake: keying on the
  // template is what looks right and silently does nothing on a reopen.
  session: number,
): DocumentPreviewState {
  const [state, setState] = useState<DocumentPreviewState>({
    url: null,
    loading: false,
    error: null,
  });
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const swap = useCallback((next: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
  }, []);

  // useLayoutEffect, not useEffect: the reset has to land before the paint that would otherwise show
  // the previous session's document (docs/modals.md).
  useLayoutEffect(() => {
    // `session` is read here so the effect is keyed on it: the reset belongs to the modal OPENING,
    // and the linter counts a dependency it cannot see used as unnecessary.
    void session;
    swap(null);
    abortRef.current?.abort();
    setState({ url: null, loading: false, error: null });
  }, [session, swap]);

  const body = draft ? JSON.stringify(draft) : null;

  useEffect(() => {
    // Keyed on the session as well as the draft, and it has to be: reopening the modal on the same
    // template hands this effect an IDENTICAL body, so without the session the reset above would
    // clear the document and nothing would ever ask for it again — an empty preview panel until the
    // operator types something. (The linter counts a dependency it cannot see used as unnecessary.)
    void session;
    if (!body) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const res = await mediaFetch("/api/v1/document-templates/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          // The service's refusal names the block and the rule; showing it verbatim is the whole
          // point of the round trip.
          const payload = (await res.json().catch(() => null)) as {
            message?: string;
            error?: string;
          } | null;
          // Re-checked AFTER the body is parsed, exactly like the success path re-checks after
          // `res.blob()`. Reading the body is another await, and a draft change during it makes this
          // answer stale: without the second check a refusal about the PREVIOUS draft replaces the
          // new one's loading state, and sits there naming a block the operator has already fixed
          // until the newer request lands (docs/modals.md).
          if (cancelled) return;
          setState({
            url: null,
            loading: false,
            error: payload?.message ?? payload?.error ?? `HTTP ${res.status}`,
          });
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        swap(next);
        setState({ url: next, loading: false, error: null });
      } catch (e) {
        if (cancelled || (e as Error)?.name === "AbortError") return;
        setState({ url: null, loading: false, error: (e as Error).message });
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [body, session, swap]);

  useEffect(() => () => swap(null), [swap]);

  return state;
}
