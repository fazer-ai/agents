/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { Modal, useModalController } from "@/client/components/Modal";
import { reloadOnceForFailedChunk } from "@/client/lib/staleBuild";
import { hasUnsavedChanges } from "@/client/lib/unsavedGuard";

// A modal whose save is in flight (`busy`) refuses every user-driven close, and the console's own
// reloads (a stale tab at the next route change, a dynamic import a deploy removed) must not end
// that save either, whether or not the form is dirty: the threshold editor on the instance health
// page is clean while it saves, and its page lazy-loads the sparklines it refreshes underneath.

function SavingModal({ busy }: { busy: boolean }) {
  const modal = useModalController();
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    modal.open();
  }, [modal]);
  return (
    <Modal modal={modal} title="Threshold" busy={busy}>
      <p>Body content</p>
    </Modal>
  );
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("a modal saving in flight holds the console's own reloads", () => {
  afterEach(() => cleanup());

  test("a failed dynamic import does not reload over a clean modal that is saving", () => {
    render(<SavingModal busy />);
    let reloads = 0;
    const reloaded = reloadOnceForFailedChunk({
      ownBuild: "9.9.1+a",
      storage: memoryStorage(),
      reload: () => {
        reloads += 1;
      },
    });
    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
  });

  test("the hold ends when the save settles", () => {
    const view = render(<SavingModal busy />);
    const whileSaving = hasUnsavedChanges();
    view.rerender(<SavingModal busy={false} />);
    const afterSettling = hasUnsavedChanges();
    expect([whileSaving, afterSettling]).toEqual([true, false]);
  });
});
