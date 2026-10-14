import { describe, expect, test } from "bun:test";
import {
  createBuildWatch,
  importWithReload,
  reloadOnceForFailedChunk,
} from "@/client/lib/staleBuild";

// A console tab knows the build it was loaded from; the server names the build it serves on every
// response. The tab is stale exactly while the latest response names another build.

const served = (build?: string, version?: string) => ({
  headers: new Headers({
    ...(build ? { "x-app-build": build } : {}),
    ...(version ? { "x-app-version": version } : {}),
  }),
});

function memoryStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("the build watch", () => {
  test("a response from another build marks the tab stale and names the server's version", () => {
    const watch = createBuildWatch("9.9.1+a");
    watch.note(served("9.9.2+b", "9.9.2"));
    expect(watch.get()).toEqual({ stale: true, serverVersion: "9.9.2" });
  });

  test("a response from its own build leaves the tab current", () => {
    const watch = createBuildWatch("9.9.1+a");
    watch.note(served("9.9.1+a", "9.9.1"));
    expect(watch.get().stale).toBe(false);
  });

  test("a redeploy of the same version is still another build", () => {
    const watch = createBuildWatch("9.9.1+a");
    watch.note(served("9.9.1+c", "9.9.1"));
    expect(watch.get()).toEqual({ stale: true, serverVersion: "9.9.1" });
  });

  test("a rollback to the tab's own build clears the verdict", () => {
    const watch = createBuildWatch("9.9.1+a");
    watch.note(served("9.9.2+b", "9.9.2"));
    watch.note(served("9.9.1+a", "9.9.1"));
    expect(watch.get().stale).toBe(false);
  });

  test("a response that names no build says nothing about the tab", () => {
    const watch = createBuildWatch("9.9.1+a");
    watch.note(served("9.9.2+b", "9.9.2"));
    watch.note(served());
    expect(watch.get().stale).toBe(true);
  });

  test("a response that names no build does not make a current tab stale", () => {
    const watch = createBuildWatch("9.9.1+a");
    watch.note(served());
    expect(watch.get().stale).toBe(false);
  });

  test("a bundle with no build of its own (dev) never turns stale", () => {
    const watch = createBuildWatch("");
    watch.note(served("9.9.2+b", "9.9.2"));
    expect(watch.get().stale).toBe(false);
  });

  test("subscribers hear a change once, and not a repeat of the same verdict", () => {
    const watch = createBuildWatch("9.9.1+a");
    let calls = 0;
    watch.subscribe(() => calls++);
    watch.note(served("9.9.2+b", "9.9.2"));
    watch.note(served("9.9.2+b", "9.9.2"));
    expect(calls).toBe(1);
  });
});

describe("the reload after a chunk fails", () => {
  test("reloads the first time a build sees a chunk fail", () => {
    let reloads = 0;
    const reloaded = reloadOnceForFailedChunk({
      ownBuild: "9.9.1+a",
      storage: memoryStorage(),
      reload: () => reloads++,
    });
    expect([reloaded, reloads]).toEqual([true, 1]);
  });

  test("does not reload a second time from the same build", () => {
    const storage = memoryStorage();
    let reloads = 0;
    const reload = () => reloads++;
    reloadOnceForFailedChunk({ ownBuild: "9.9.1+a", storage, reload });
    const again = reloadOnceForFailedChunk({
      ownBuild: "9.9.1+a",
      storage,
      reload,
    });
    expect([again, reloads]).toEqual([false, 1]);
  });

  test("a newer build gets its own reload", () => {
    const storage = memoryStorage();
    let reloads = 0;
    const reload = () => reloads++;
    reloadOnceForFailedChunk({ ownBuild: "9.9.1+a", storage, reload });
    const newer = reloadOnceForFailedChunk({
      ownBuild: "9.9.2+b",
      storage,
      reload,
    });
    expect([newer, reloads]).toEqual([true, 2]);
  });

  test("unsaved changes refuse the reload and leave it unspent", () => {
    const storage = memoryStorage();
    let reloads = 0;
    const reload = () => reloads++;
    const whileDirty = reloadOnceForFailedChunk({
      ownBuild: "9.9.1+a",
      storage,
      reload,
      unsaved: () => true,
    });
    const afterSaving = reloadOnceForFailedChunk({
      ownBuild: "9.9.1+a",
      storage,
      reload,
      unsaved: () => false,
    });
    expect([whileDirty, afterSaving, reloads]).toEqual([false, true, 1]);
  });

  test("storage that cannot remember the reload refuses it", () => {
    let reloads = 0;
    const reloaded = reloadOnceForFailedChunk({
      ownBuild: "9.9.1+a",
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
      reload: () => reloads++,
    });
    expect([reloaded, reloads]).toEqual([false, 0]);
  });

  test("an import that loads is handed through untouched", async () => {
    expect(await importWithReload(async () => ({ default: 42 }))).toEqual({
      default: 42,
    });
  });
});
