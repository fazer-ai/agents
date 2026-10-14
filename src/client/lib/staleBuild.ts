import { lazy, useSyncExternalStore } from "react";
import { APP_BUILD_ID } from "@/client/lib/env";
import {
  hasUnsavedChanges,
  suppressUnloadPrompt,
} from "@/client/lib/unsavedGuard";
import {
  SERVED_BUILD_HEADER,
  SERVED_VERSION_HEADER,
} from "@/lib/served-build-headers";

// Whether this tab runs the frontend the server is serving now. The server names its build on every
// response (api/lib/served-build.ts) and every API response passes through `noteServedBuild`, so a
// deploy is seen on the first request after it. The verdict follows the latest response: a rollback
// to this tab's build clears it. Separate from the release check in UpdatesContext, which compares
// the INSTALLED server with the newest release.

export type StaleBuildState = { stale: boolean; serverVersion: string };

export function createBuildWatch(ownBuild: string) {
  let state: StaleBuildState = { stale: false, serverVersion: "" };
  const listeners = new Set<() => void>();

  return {
    note(response: Pick<Response, "headers">): void {
      // NOTE: no own build is dev, where nothing is inlined; no served build is dev on the other side,
      // or a response that never reached the app (a proxy's error page). Neither says anything.
      if (!ownBuild) return;
      const served = response.headers.get(SERVED_BUILD_HEADER);
      if (!served) return;
      const next: StaleBuildState = {
        stale: served !== ownBuild,
        serverVersion: response.headers.get(SERVED_VERSION_HEADER) ?? "",
      };
      if (
        next.stale === state.stale &&
        next.serverVersion === state.serverVersion
      ) {
        return;
      }
      state = next;
      for (const listener of listeners) listener();
    },
    get: (): StaleBuildState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let watch = createBuildWatch(APP_BUILD_ID);

export function noteServedBuild(response: Pick<Response, "headers">): void {
  watch.note(response);
}

export function getStaleBuild(): StaleBuildState {
  return watch.get();
}

const subscribe = (listener: () => void) => watch.subscribe(listener);

export function useStaleBuild(): StaleBuildState {
  return useSyncExternalStore(subscribe, getStaleBuild);
}

// Test seam: the bundle's own id is inlined at build time, and a test runs a bundle that has none.
// Drops the verdict too, so one test file cannot leave the next one looking at a stale tab.
export function resetBuildWatch(ownBuild: string = APP_BUILD_ID): void {
  watch = createBuildWatch(ownBuild);
}

// The operator's own Reload, called behind the discard confirm (useConfirmLeave), which already
// asked about anything unsaved; the native prompt would be a second ask.
export function reloadIntoServedBuild(): void {
  suppressUnloadPrompt();
  window.location.reload();
}

// At most one reload per build: the reload fetches the current document, so a chunk that still
// fails from the SAME build is not a deploy, and reloading again would loop. Keyed in sessionStorage
// so it survives the reload it guards; storage that cannot be written refuses the reload for the same
// reason. Unsaved changes refuse it too: the operator could cancel the unload prompt, the page would
// stay without the module, and the caller's own error path is the only way back from there.
const CHUNK_RELOAD_KEY = "@agents:chunk-reload-build";

export function reloadOnceForFailedChunk({
  ownBuild = APP_BUILD_ID,
  storage = globalThis.sessionStorage,
  reload = () => window.location.reload(),
  unsaved = hasUnsavedChanges,
}: {
  ownBuild?: string;
  storage?: Pick<Storage, "getItem" | "setItem">;
  reload?: () => void;
  unsaved?: () => boolean;
} = {}): boolean {
  if (unsaved()) return false;
  try {
    if (storage.getItem(CHUNK_RELOAD_KEY) === ownBuild) return false;
    storage.setItem(CHUNK_RELOAD_KEY, ownBuild);
  } catch {
    return false;
  }
  reload();
  return true;
}

// A dynamic import whose file a deploy removed reloads the page once instead of leaving a broken
// screen. While the reload is under way the promise never settles, so nothing renders the error.
export function importWithReload<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((error: unknown) => {
    if (reloadOnceForFailedChunk()) return new Promise<T>(() => {});
    throw error;
  });
}

export const lazyWithReload: typeof lazy = (load) =>
  lazy(() => importWithReload(load));
