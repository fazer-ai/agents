/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { hasUnsavedChanges } from "@/client/lib/unsavedGuard";
import { usePlaygroundChat } from "@/client/pages/agents/usePlaygroundChat";

// The playground composer's unsent message is input a reload would lose, so while it holds text the
// console's own reloads (a stale tab, a failed import) wait.

const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ sessions: [] }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(cleanup);

test("an unsent message holds the reload, and clearing it lets go", () => {
  const hook = renderHook(() => usePlaygroundChat("7", false));
  const before = hasUnsavedChanges();
  act(() => hook.result.current.setInput("half a question"));
  const typed = hasUnsavedChanges();
  act(() => hook.result.current.setInput("   "));
  const blank = hasUnsavedChanges();
  expect([before, typed, blank]).toEqual([false, true, false]);
});

test("leaving the playground with a draft lets go of it", () => {
  const hook = renderHook(() => usePlaygroundChat("7", false));
  act(() => hook.result.current.setInput("half a question"));
  hook.unmount();
  expect(hasUnsavedChanges()).toBe(false);
});
