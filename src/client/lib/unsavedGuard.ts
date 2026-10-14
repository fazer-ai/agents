import { useEffect, useRef } from "react";

// Browser-level guards for unsaved changes, reference-counted at module level so they survive
// unmounts and compose across several dirty forms:
//   1. `beforeunload`, the NATIVE prompt: refresh, tab close, external navigation. It never fires on
//      in-app (SPA) navigation, the Back button between two app routes included.
//   2. A Back-button trap: `useBlocker` needs a data router, which this app does not use, so a
//      same-URL sentinel entry is pushed while a guard is active; popping it with Back re-arms it and
//      notifies the top blocker, which shows our own confirm. react-router's location is untouched.

const isBrowser = typeof window !== "undefined";

// --- 1. beforeunload (native prompt) --------------------------------------

let beforeUnloadCount = 0;

function onBeforeUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
  // NOTE: legacy browsers require returnValue to be set to trigger the prompt.
  e.returnValue = "";
}

// Arm the native unload prompt; returns a release fn (ref-counted across all
// callers, so the listener is attached once and removed when the last releases).
export function acquireBeforeUnload(): () => void {
  if (!isBrowser) return () => undefined;
  beforeUnloadCount += 1;
  if (beforeUnloadCount === 1) {
    window.addEventListener("beforeunload", onBeforeUnload);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    beforeUnloadCount -= 1;
    if (beforeUnloadCount === 0) {
      window.removeEventListener("beforeunload", onBeforeUnload);
    }
  };
}

// Input that is not a form change but a reload would still lose: a composer's unsent message, or a
// modal's save in flight (`busy`). It arms no prompt (leaving the screen keeps it in memory, as
// before), and only stops the reloads the console starts by itself (client/lib/staleBuild.ts).
let heldDrafts = 0;

export function useHeldDraft(active: boolean) {
  useEffect(() => {
    if (!active) return;
    heldDrafts += 1;
    return () => {
      heldDrafts -= 1;
    };
  }, [active]);
}

// Work the operator started that the server does not have yet (a write on the wire, a voice note
// between stop and upload). Held by the operation itself, not by a component, so leaving the screen
// mid-flight still keeps the console's own reloads off until it settles.
let inFlight = 0;

export function holdInFlight(): () => void {
  inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
  };
}

export async function holdWhile<T>(work: () => Promise<T>): Promise<T> {
  const release = holdInFlight();
  try {
    return await work();
  } finally {
    release();
  }
}

// A write the server may already be applying (POST, PUT, PATCH, DELETE) holds the console's own reloads
// until its answer has been read: a reload aborts the request mid-flight and drops the answer, which
// for a password change is the cookie of the session that replaces the current one. Wraps the API
// client's fetch, so it holds whichever screen started the write and outlives that screen. A read
// holds nothing.
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function holdingWrites(
  fetcher: () => typeof fetch = () => globalThis.fetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (!WRITES.has(method)) return fetcher()(input, init);
    const release = holdInFlight();
    let response: Response;
    try {
      response = await fetcher()(input, init);
    } catch (error) {
      release();
      throw error;
    }
    return releasedWhenRead(response, release);
  }) as typeof fetch;
}

// The same response, whose body releases the hold once it has been read to the end, fails or is
// cancelled.
function releasedWhenRead(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            release();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      cancel(reason) {
        release();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// Whether a reload now would lose something: a form or modal the native prompt is guarding, a held
// draft, or work in flight.
export function hasUnsavedChanges(): boolean {
  return beforeUnloadCount > 0 || heldDrafts > 0 || inFlight > 0;
}

// Force-detach the native prompt. For a confirmed full-page reload (e.g. the
// tenant switch) where the user already approved leaving via our own dialog and
// the document is about to be replaced anyway — so the native prompt would be a
// redundant second ask whose "cancel" leaves the side effect half-applied.
export function suppressUnloadPrompt() {
  if (!isBrowser) return;
  window.removeEventListener("beforeunload", onBeforeUnload);
}

// --- 2. Back-button trap (in-app confirm) ---------------------------------

const SENTINEL_KEY = "__unsavedBackGuard";
type BackBlocker = () => void;

const blockers: BackBlocker[] = [];
let armed = false;

function sentinelState(): unknown {
  // Preserve react-router's history state (idx/key/usr) and just add our marker,
  // so popping back to the real entry does not desync react-router's index.
  const current =
    (window.history.state as Record<string, unknown> | null) ?? {};
  return { ...current, [SENTINEL_KEY]: true };
}

function hasSentinel(): boolean {
  const s = window.history.state as Record<string, unknown> | null;
  return !!s && s[SENTINEL_KEY] === true;
}

function onPopState() {
  if (blockers.length === 0) return;
  // The user pressed Back, consuming our sentinel (the URL is unchanged because
  // the sentinel was pushed for the same location). Re-arm immediately so the
  // form stays protected if the user dismisses the confirm, then notify the
  // topmost blocker so it can prompt.
  window.history.pushState(sentinelState(), "");
  const top = blockers[blockers.length - 1];
  top?.();
}

function arm() {
  if (armed) return;
  armed = true;
  window.history.pushState(sentinelState(), "");
  window.addEventListener("popstate", onPopState);
}

function disarm() {
  if (!armed) return;
  armed = false;
  // Detach BEFORE popping the sentinel: the back() below fires a popstate for a
  // same-URL entry that is our own cleanup, not a user Back, so the listener
  // must already be gone when it arrives (no flag needed).
  window.removeEventListener("popstate", onPopState);
  // Pop the leftover sentinel (if still on top) so the next Back is not wasted
  // on a dead same-URL entry.
  if (hasSentinel()) window.history.back();
}

// Register a Back-button blocker. While at least one is registered, the Back
// button does not navigate away; it pops the sentinel and invokes the topmost
// blocker (LIFO) instead. Returns an unregister fn.
export function pushBackBlocker(onBack: BackBlocker): () => void {
  if (!isBrowser) return () => undefined;
  blockers.push(onBack);
  arm();
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const i = blockers.lastIndexOf(onBack);
    if (i >= 0) blockers.splice(i, 1);
    if (blockers.length === 0) disarm();
  };
}

// Honor a Back press that a PAGE guard confirmed (the user chose "discard").
// When the trap fired, `onPopState` re-pushed the sentinel, so we are now
// sitting on it, one entry above the guarded page. Unlike a modal (which just
// closes and stays on the same URL), a page must actually leave: detach the
// listener and traverse past BOTH the sentinel and the page entry to the real
// previous location. A single `history.go` avoids racing two history ops.
export function leaveViaBackTrap() {
  if (!isBrowser) return;
  window.removeEventListener("popstate", onPopState);
  armed = false;
  window.history.go(hasSentinel() ? -2 : -1);
}

// --- React hooks -----------------------------------------------------------

// Arm the native beforeunload prompt while `active` is true.
export function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    return acquireBeforeUnload();
  }, [active]);
}

// Trap the Back button while `active` is true, calling `onBack` instead of
// navigating. `onBack` is read through a ref so it can change without
// re-arming the sentinel.
export function useBackGuard(active: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!active) return;
    return pushBackBlocker(() => onBackRef.current());
  }, [active]);
}
