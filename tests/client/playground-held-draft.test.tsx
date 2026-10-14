/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { hasUnsavedChanges } from "@/client/lib/unsavedGuard";
import { usePlaygroundChat } from "@/client/pages/agents/usePlaygroundChat";
import { until } from "@/tests/utils/poll";

// The playground composer's unsent message is input a reload would lose, so while it holds text the
// console's own reloads (a stale tab, a failed import) wait.

const realFetch = globalThis.fetch;
// Requests held open by the stub, answered with a failure after each test so no operation outlives
// the test that started it.
const pending: ((r: Response) => void)[] = [];
let threadsHang = false;
let followupHangs = false;
let transcribeFails = false;
// The transcription and the file extraction never answer, nor does opening a thread while
// `threadsHang` is set, so the test can look at the hook while it is in flight.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (transcribeFails && url.includes("/audio/transcribe"))
    return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
  if (
    url.includes("/audio/transcribe") ||
    url.includes("/file/extract") ||
    (threadsHang && url.endsWith("/playground/threads")) ||
    (followupHangs && url.includes("/playground/followup"))
  )
    return new Promise<Response>((resolve) => pending.push(resolve));
  const body = url.endsWith("/playground/threads")
    ? { threadId: "1:playground:7:fresh" }
    : { sessions: [] };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

// A microphone and a recorder that behave like the browser's for start, pause and stop.
let trackEnded: (() => void) | null = null;
class FakeRecorder {
  static last: FakeRecorder | null = null;
  constructor() {
    FakeRecorder.last = this;
  }
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
    // Stopping the microphone's track ends the recorder, as the browser does, on a later task.
    getUserMedia: async () =>
      ({
        getTracks: () => [
          {
            stop: () => {
              const rec = FakeRecorder.last;
              if (rec && rec.state !== "inactive") {
                rec.state = "inactive";
                trackEnded = () => {
                  rec.ondataavailable?.({ data: new Blob(["voice"]) });
                  rec.onstop?.();
                };
              }
            },
          },
        ],
      }) as unknown as MediaStream,
  },
});
afterAll(() => {
  globalThis.fetch = realFetch;
  g.MediaRecorder = realRecorder;
  if (realDevices)
    Object.defineProperty(navigator, "mediaDevices", realDevices);
});
afterEach(async () => {
  cleanup();
  // A request can be issued after the test returns, so answer until nothing is waiting or held.
  for (let i = 0; i < 100 && (pending.length > 0 || hasUnsavedChanges()); i++) {
    for (const answer of pending.splice(0))
      answer(new Response(JSON.stringify({ error: "gone" }), { status: 500 }));
    await new Promise((r) => setTimeout(r, 10));
  }
});

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

test("a stopped recording holds the reload until the browser hands it over", async () => {
  // Browsers deliver `stop` on a later task, not inside stop().
  const syncStop = FakeRecorder.prototype.stop;
  FakeRecorder.prototype.stop = function (this: FakeRecorder) {
    this.state = "inactive";
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(["voice"]) });
      this.onstop?.();
    }, 20);
  };
  try {
    const hook = renderHook(() => usePlaygroundChat("7", false));
    await act(() => hook.result.current.startRecording());
    act(() => hook.result.current.stopRecording());
    const beforeHandOver = hasUnsavedChanges();
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect([
      beforeHandOver,
      hook.result.current.transcribing,
      hasUnsavedChanges(),
    ]).toEqual([true, true, true]);
  } finally {
    FakeRecorder.prototype.stop = syncStop;
  }
});

test("once the recording is handed over and its request ends, the hold lets go", async () => {
  transcribeFails = true;
  try {
    const hook = renderHook(() => usePlaygroundChat("7", false));
    await act(() => hook.result.current.startRecording());
    await act(async () => {
      hook.result.current.stopRecording();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect([hook.result.current.transcribing, hasUnsavedChanges()]).toEqual([
      false,
      false,
    ]);
  } finally {
    transcribeFails = false;
  }
});

test("leaving the editor while a send waits for its thread keeps the hold until it settles", async () => {
  threadsHang = true;
  try {
    const hook = renderHook(() => usePlaygroundChat("7", false));
    act(() => hook.result.current.setInput("first question"));
    await act(async () => {
      void hook.result.current.send();
      await Promise.resolve();
    });
    hook.unmount();
    expect(hasUnsavedChanges()).toBe(true);
  } finally {
    threadsHang = false;
  }
});

test("leaving the editor while a file is read keeps the hold", async () => {
  const hook = renderHook(() => usePlaygroundChat("7", false));
  await act(async () => {
    void hook.result.current.sendFile(
      new File(["%PDF"], "quote.pdf", { type: "application/pdf" }),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  hook.unmount();
  expect(hasUnsavedChanges()).toBe(true);
});

test("leaving the editor right after stopping a recording keeps the hold until it is handed over", async () => {
  const syncStop = FakeRecorder.prototype.stop;
  let handOver: (() => void) | null = null;
  FakeRecorder.prototype.stop = function (this: FakeRecorder) {
    this.state = "inactive";
    handOver = () => {
      this.ondataavailable?.({ data: new Blob(["voice"]) });
      this.onstop?.();
    };
  };
  try {
    const hook = renderHook(() => usePlaygroundChat("7", false));
    await act(() => hook.result.current.startRecording());
    act(() => hook.result.current.stopRecording());
    hook.unmount();
    const beforeHandOver = hasUnsavedChanges();
    transcribeFails = true;
    await act(async () => {
      (handOver as (() => void) | null)?.();
      await until("the failed upload to settle", () => !hasUnsavedChanges());
    });
    expect([beforeHandOver, hasUnsavedChanges()]).toEqual([true, false]);
  } finally {
    transcribeFails = false;
    FakeRecorder.prototype.stop = syncStop;
  }
});

test("a simulated follow-up in flight keeps the hold after the editor unmounts", async () => {
  const hook = renderHook(() => usePlaygroundChat("7", false));
  act(() => hook.result.current.setInput("a question"));
  await act(async () => {
    await hook.result.current.send();
  });
  followupHangs = true;
  try {
    const before = hasUnsavedChanges();
    await act(async () => {
      void hook.result.current.simulateFollowup();
      await Promise.resolve();
    });
    hook.unmount();
    expect([before, hasUnsavedChanges()]).toEqual([false, true]);
  } finally {
    followupHangs = false;
  }
});

test("a recording cancelled between stop and hand-over lets go of the hold", async () => {
  const syncStop = FakeRecorder.prototype.stop;
  let handOver: (() => void) | null = null;
  FakeRecorder.prototype.stop = function (this: FakeRecorder) {
    this.state = "inactive";
    handOver = () => {
      this.ondataavailable?.({ data: new Blob(["voice"]) });
      this.onstop?.();
    };
  };
  try {
    const hook = renderHook(() => usePlaygroundChat("7", false));
    await act(() => hook.result.current.startRecording());
    act(() => hook.result.current.stopRecording());
    act(() => hook.result.current.cancelRecording());
    await act(async () => {
      (handOver as (() => void) | null)?.();
      await Promise.resolve();
    });
    expect(hasUnsavedChanges()).toBe(false);
  } finally {
    FakeRecorder.prototype.stop = syncStop;
  }
});

test("leaving the editor mid-recording holds the reload until the recorder hands the audio over", async () => {
  trackEnded = null;
  const hook = renderHook(() => usePlaygroundChat("7", false));
  await act(() => hook.result.current.startRecording());
  act(() => hook.result.current.pauseRecording());
  hook.unmount();
  const beforeHandOver = hasUnsavedChanges();
  transcribeFails = true;
  try {
    await act(async () => {
      (trackEnded as (() => void) | null)?.();
      await until("the failed upload to settle", () => !hasUnsavedChanges());
    });
    expect([beforeHandOver, trackEnded !== null]).toEqual([true, true]);
  } finally {
    transcribeFails = false;
  }
});
