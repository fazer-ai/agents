/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { hasUnsavedChanges } from "@/client/lib/unsavedGuard";
import { usePlaygroundCall } from "@/client/pages/agents/usePlaygroundCall";
import {
  installFakeWebSocket,
  restoreWebSocket,
  sockets,
} from "@/tests/utils/fake-websocket";
import { until } from "@/tests/utils/poll";

// Leaving the Playground while a call is still starting (the browser's microphone prompt, or the
// setup request after it) cancels it: nothing opens after the screen is gone, and a microphone is
// released at once instead of streaming with no hang-up button anywhere. The setup comes after the
// microphone because the ticket it hands out lasts a minute, and the prompt can take longer.

const realFetch = globalThis.fetch;
let answerSetup: (() => void) | null = null;
let setupCalls = 0;
// Set by the test whose setup answer cannot be read.
let unreadableSetup = false;
globalThis.fetch = (async () => {
  setupCalls++;
  await new Promise<void>((resolve) => {
    answerSetup = resolve;
  });
  if (unreadableSetup)
    return new Response("{ truncated", {
      headers: { "content-type": "application/json" },
    });
  return new Response(JSON.stringify({ ok: true, ticket: "t" }), {
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

// The call's audio context. `suspendAudio` is the browser that keeps it suspended (Safari outside a
// gesture); `contexts` is every one made, with when (relative to the microphone prompt) it was made.
let suspendAudio = false;
const contexts: Array<{
  state: string;
  closed: boolean;
  beforeMic: boolean;
  resumedBeforeMic: boolean | null;
}> = [];
const realAudioContext = (globalThis as { AudioContext?: unknown })
  .AudioContext;
class FakeAudioContext {
  state = "suspended";
  closed = false;
  beforeMic = micAsked === 0;
  resumedBeforeMic: boolean | null = null;
  constructor() {
    contexts.push(this);
  }
  async resume() {
    this.resumedBeforeMic ??= micAsked === 0;
    if (!suspendAudio) this.state = "running";
  }
  async close() {
    this.closed = true;
    this.state = "closed";
  }
}
(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;

let grant: ((stream: MediaStream) => void) | null = null;
let micAsked = 0;
const realDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: () => {
      micAsked++;
      return new Promise<MediaStream>((resolve) => {
        grant = resolve;
      });
    },
  },
});
installFakeWebSocket();

afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as { AudioContext?: unknown }).AudioContext = realAudioContext;
  // happy-dom keeps `mediaDevices` on the prototype: with no own property to put back, the fake is
  // deleted, or every later file in the process would be handed this one's microphone.
  if (realDevices)
    Object.defineProperty(navigator, "mediaDevices", realDevices);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  restoreWebSocket();
});
afterEach(async () => {
  cleanup();
  // A setup request left unanswered is a write in flight, which keeps every later file's reload
  // guard (`hasUnsavedChanges`) on for the rest of the process.
  answerSetup?.();
  await until("the setup's write to settle", () => !hasUnsavedChanges());
  answerSetup = null;
  grant = null;
  setupCalls = 0;
  micAsked = 0;
  sockets.length = 0;
  contexts.length = 0;
  suspendAudio = false;
});

function fakeMic() {
  const counts = { stopped: 0 };
  const stream = {
    getTracks: () => [{ stop: () => counts.stopped++ }],
  } as unknown as MediaStream;
  return { counts, stream };
}

test("the ticket is asked for only once the microphone is granted", async () => {
  const mic = fakeMic();
  const hook = renderHook(() => usePlaygroundCall("7"));
  act(() => void hook.result.current.start());
  await until("the microphone prompt", () => grant !== null);
  expect(setupCalls).toBe(0);
  grant?.(mic.stream);
  await until("the setup request", () => answerSetup !== null);
  hook.unmount();
});

test("a microphone granted after the Playground closed is released, and nothing is asked for", async () => {
  const mic = fakeMic();
  const hook = renderHook(() => usePlaygroundCall("7"));
  act(() => void hook.result.current.start());
  await until("the microphone prompt", () => grant !== null);
  hook.unmount();
  grant?.(mic.stream);
  await until("the late microphone released", () => mic.counts.stopped === 1);
  expect(setupCalls).toBe(0);
  expect(sockets).toHaveLength(0);
});

test("leaving while the setup is pending releases the microphone at once, and no line opens", async () => {
  const mic = fakeMic();
  const hook = renderHook(() => usePlaygroundCall("7"));
  act(() => void hook.result.current.start());
  await until("the microphone prompt", () => grant !== null);
  grant?.(mic.stream);
  await until("the setup request", () => answerSetup !== null);
  hook.unmount();
  // Before the setup answers: nothing else would ever stop it if the request never came back.
  expect(mic.counts.stopped).toBeGreaterThan(0);
  answerSetup?.();
  await until("the setup answered", () => setupCalls === 1);
  expect(micAsked).toBe(1);
  expect(sockets).toHaveLength(0);
});

test("a setup answer that cannot be read fails the call and releases the microphone", async () => {
  unreadableSetup = true;
  try {
    const mic = fakeMic();
    const hook = renderHook(() => usePlaygroundCall("7"));
    act(() => void hook.result.current.start());
    await until("the microphone prompt", () => grant !== null);
    grant?.(mic.stream);
    await until("the setup request", () => answerSetup !== null);
    answerSetup?.();
    await until(
      "the call to fail",
      () => hook.result.current.call.state === "failed",
    );
    expect(mic.counts.stopped).toBeGreaterThan(0);
    expect(sockets).toHaveLength(0);
  } finally {
    unreadableSetup = false;
  }
});

test("the call's audio is started in the click, before the microphone prompt", async () => {
  const hook = renderHook(() => usePlaygroundCall("7"));
  act(() => void hook.result.current.start());
  await until("the microphone prompt", () => grant !== null);
  expect(contexts.map((c) => [c.beforeMic, c.resumedBeforeMic])).toEqual([
    [true, true],
  ]);
  hook.unmount();
  expect(contexts[0]?.closed).toBe(true);
});

test("audio the browser kept suspended fails the call, and releases the microphone", async () => {
  suspendAudio = true;
  const mic = fakeMic();
  const hook = renderHook(() => usePlaygroundCall("7"));
  act(() => void hook.result.current.start());
  await until("the microphone prompt", () => grant !== null);
  grant?.(mic.stream);
  await until("the setup request", () => answerSetup !== null);
  answerSetup?.();
  await until(
    "the call to fail",
    () => hook.result.current.call.state === "failed",
  );
  expect(hook.result.current.call).toMatchObject({ problem: "audio" });
  expect(mic.counts.stopped).toBeGreaterThan(0);
  expect(contexts[0]?.closed).toBe(true);
  expect(sockets).toHaveLength(0);
});

// "Save and call": the save runs inside the call's attempt, after the click made the audio context
// (the gesture Safari needs) and before the microphone is asked for.
test("leaving while the save before the call is pending closes the audio, and asks for neither the microphone nor the ticket", async () => {
  const pending: { finishSave?: (ok: boolean) => void } = {};
  const save = () =>
    new Promise<boolean>((resolve) => {
      pending.finishSave = resolve;
    });
  const hook = renderHook(() => usePlaygroundCall("7"));
  act(() => void hook.result.current.start(save));
  await until("the save to start", () => pending.finishSave !== undefined);
  expect(contexts.map((c) => c.beforeMic)).toEqual([true]);
  hook.unmount();
  pending.finishSave?.(true);
  await until("the audio closed", () => contexts[0]?.closed === true);
  expect(micAsked).toBe(0);
  expect(setupCalls).toBe(0);
  expect(sockets).toHaveLength(0);
});

test("a save that fails before the call goes back to the call button, with the audio closed", async () => {
  const hook = renderHook(() => usePlaygroundCall("7"));
  await act(() => hook.result.current.start(async () => false));
  expect(hook.result.current.call.state).toBe("idle");
  expect(contexts[0]?.closed).toBe(true);
  expect(micAsked).toBe(0);
  hook.unmount();
});

test("a cancelled call answering late does not let go of the microphone a newer call holds", async () => {
  const first = fakeMic();
  const second = fakeMic();
  const hook = renderHook(() => usePlaygroundCall("7"));
  act(() => void hook.result.current.start());
  await until("the first microphone prompt", () => grant !== null);
  grant?.(first.stream);
  await until("the first setup request", () => answerSetup !== null);
  const answerFirst = answerSetup as (() => void) | null;
  act(() => hook.result.current.cancel());
  grant = null;
  act(() => void hook.result.current.start());
  await until("the second microphone prompt", () => grant !== null);
  (grant as ((stream: MediaStream) => void) | null)?.(second.stream);
  await until("the second setup request", () => setupCalls === 2);
  // Cancelling stopped the first microphone once; its late answer stopping it again is the sign the
  // stale attempt has run its release.
  expect(first.counts.stopped).toBe(1);
  answerFirst?.();
  await until(
    "the first attempt's late answer",
    () => first.counts.stopped === 2,
  );
  // The first attempt's late answer released what it held; cancelling now must still reach the
  // second call's microphone and audio, which nothing else would stop while its request is pending.
  act(() => hook.result.current.cancel());
  expect(second.counts.stopped).toBe(1);
  expect(contexts[1]?.closed).toBe(true);
  hook.unmount();
});
