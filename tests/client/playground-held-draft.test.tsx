/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { hasUnsavedChanges } from "@/client/lib/unsavedGuard";
import { usePlaygroundChat } from "@/client/pages/agents/usePlaygroundChat";

// The playground composer's unsent message is input a reload would lose, so while it holds text the
// console's own reloads (a stale tab, a failed import) wait.

const realFetch = globalThis.fetch;
let threadsHang = false;
// The transcription and the file extraction never answer, nor does opening a thread while
// `threadsHang` is set, so the test can look at the hook while it is in flight.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (
    url.includes("/audio/transcribe") ||
    url.includes("/file/extract") ||
    (threadsHang && url.endsWith("/playground/threads"))
  )
    return new Promise<Response>(() => {});
  const body = url.endsWith("/playground/threads")
    ? { threadId: "1:playground:7:fresh" }
    : { sessions: [] };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

// A microphone and a recorder that behave like the browser's for start, pause and stop.
class FakeRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"]) });
    this.onstop?.();
  }
}
const g = globalThis as unknown as Record<string, unknown>;
const realRecorder = g.MediaRecorder;
g.MediaRecorder = FakeRecorder;
const realDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () =>
      ({ getTracks: () => [] }) as unknown as MediaStream,
  },
});
afterAll(() => {
  globalThis.fetch = realFetch;
  g.MediaRecorder = realRecorder;
  if (realDevices)
    Object.defineProperty(navigator, "mediaDevices", realDevices);
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

test("a recording, running or paused, holds the reload, and a cancel lets go", async () => {
  const hook = renderHook(() => usePlaygroundChat("7", false));
  await act(() => hook.result.current.startRecording());
  const recording = hasUnsavedChanges();
  act(() => hook.result.current.pauseRecording());
  const paused = hasUnsavedChanges();
  act(() => hook.result.current.cancelRecording());
  const canceled = hasUnsavedChanges();
  expect([recording, paused, canceled]).toEqual([true, true, false]);
});

test("a stopped recording still holds the reload while it is being transcribed", async () => {
  const hook = renderHook(() => usePlaygroundChat("7", false));
  await act(() => hook.result.current.startRecording());
  await act(async () => {
    hook.result.current.stopRecording();
    await Promise.resolve();
  });
  expect([hook.result.current.transcribing, hasUnsavedChanges()]).toEqual([
    true,
    true,
  ]);
});

test("a file still being read into text holds the reload", async () => {
  const hook = renderHook(() => usePlaygroundChat("7", false));
  await act(async () => {
    void hook.result.current.sendFile(
      new File(["%PDF"], "quote.pdf", { type: "application/pdf" }),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(hasUnsavedChanges()).toBe(true);
});

test("a message sent but not yet posted holds the reload", async () => {
  threadsHang = true;
  const hook = renderHook(() => usePlaygroundChat("7", false));
  act(() => hook.result.current.setInput("first question"));
  await act(async () => {
    void hook.result.current.send();
    await Promise.resolve();
  });
  threadsHang = false;
  expect([hook.result.current.input, hasUnsavedChanges()]).toEqual(["", true]);
});
