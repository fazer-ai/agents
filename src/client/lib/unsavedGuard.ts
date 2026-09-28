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
