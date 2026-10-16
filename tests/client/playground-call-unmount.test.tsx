/// <reference lib="dom" />

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
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
globalThis.fetch = (async () => {
  setupCalls++;
  await new Promise<void>((resolve) => {
    answerSetup = resolve;
  });
  return new Response(JSON.stringify({ ok: true, ticket: "t" }), {
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

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
  if (realDevices)
    Object.defineProperty(navigator, "mediaDevices", realDevices);
  restoreWebSocket();
});
afterEach(() => {
  cleanup();
  answerSetup = null;
  grant = null;
  setupCalls = 0;
  micAsked = 0;
  sockets.length = 0;
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

test("a setup answered after the Playground closed releases the microphone, and no line opens", async () => {
  const mic = fakeMic();
  const hook = renderHook(() => usePlaygroundCall("7"));
  act(() => void hook.result.current.start());
  await until("the microphone prompt", () => grant !== null);
  grant?.(mic.stream);
  await until("the setup request", () => answerSetup !== null);
  hook.unmount();
  answerSetup?.();
  await until("the microphone released", () => mic.counts.stopped === 1);
  expect(micAsked).toBe(1);
  expect(sockets).toHaveLength(0);
});
