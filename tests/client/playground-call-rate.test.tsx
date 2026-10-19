/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  downsampler,
  usePlaygroundCall,
} from "@/client/pages/agents/usePlaygroundCall";
import {
  installFakeWebSocket,
  restoreWebSocket,
  sockets,
} from "@/tests/utils/fake-websocket";
import { until } from "@/tests/utils/poll";

// The Playground's call on a browser that, like Firefox, refuses a microphone into an audio context
// at another rate than the device's (`NotSupportedError` on `createMediaStreamSource`): the context
// runs at the device's rate, and the microphone reaches the line at the call's 16 kHz all the same.

const DEVICE_RATE = 48_000;
// Set by the test whose browser cannot build the audio graph at all.
let refuseGraph = false;
const nodes: Array<{
  onaudioprocess: ((e: unknown) => void) | null;
  disconnect: () => void;
}> = [];
const contexts: FakeAudioContext[] = [];

const chain = () => {
  const node = {
    connect: () => node,
    disconnect: () => {},
    start: () => {},
    stop: () => {},
    frequency: { value: 0 },
    gain: { value: 0, setValueAtTime: () => {} },
  };
  return node;
};
class FakeAudioContext {
  state = "suspended";
  closed = false;
  currentTime = 0;
  destination = {};
  readonly sampleRate: number;
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? DEVICE_RATE;
    contexts.push(this);
  }
  async resume() {
    this.state = "running";
  }
  async close() {
    this.closed = true;
    this.state = "closed";
  }
  createScriptProcessor() {
    const node = {
      onaudioprocess: null,
      connect: () => {},
      disconnect: () => {},
    };
    nodes.push(node);
    return node;
  }
  createMediaStreamSource() {
    if (refuseGraph || this.sampleRate !== DEVICE_RATE)
      throw new DOMException(
        "Connecting AudioNodes from AudioContexts with different sample-rate is currently not supported.",
        "NotSupportedError",
      );
    return { connect: () => {} };
  }
  createOscillator = chain;
  createGain = chain;
}

const realAudioContext = (globalThis as { AudioContext?: unknown })
  .AudioContext;
(globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ ok: true, ticket: "t" }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
const stopped = { count: 0 };
const realDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: {
    getUserMedia: async () =>
      ({
        getTracks: () => [{ stop: () => stopped.count++ }],
      }) as unknown as MediaStream,
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
afterEach(() => {
  cleanup();
  refuseGraph = false;
  nodes.length = 0;
  contexts.length = 0;
  sockets.length = 0;
  stopped.count = 0;
});

describe("the microphone brought to the call's rate", () => {
  const sine = (rate: number, n: number, from = 0) =>
    Float32Array.from({ length: n }, (_, i) =>
      Math.sin((2 * Math.PI * 440 * (from + i)) / rate),
    );

  test("keeps the call's rate across frames, whatever the device's", () => {
    for (const rate of [48_000, 44_100, 16_000, 8_000]) {
      const down = downsampler(rate);
      let out = 0;
      for (let f = 0; f < 50; f++) {
        const samples = down(sine(rate, 1024, f * 1024));
        expect(samples.every(Number.isFinite), String(rate)).toBe(true);
        out += samples.length;
      }
      const expected = (50 * 1024 * 16_000) / rate;
      expect(Math.abs(out - expected), String(rate)).toBeLessThanOrEqual(1);
    }
  });

  test("carries the sound, not just the count", () => {
    const down = downsampler(48_000);
    const out: number[] = [];
    for (let f = 0; f < 10; f++)
      out.push(...down(sine(48_000, 1024, f * 1024)));
    // Each sample is the mean of three around it: the 440 Hz tone at 16 kHz, slightly softened.
    let worst = 0;
    for (let i = 0; i < out.length; i++)
      worst = Math.max(
        worst,
        Math.abs(
          (out[i] as number) -
            Math.sin((2 * Math.PI * 440 * (3 * i + 1)) / 48_000),
        ),
      );
    expect(worst).toBeLessThan(0.01);
    expect(
      Array.from(downsampler(16_000)(Float32Array.of(0.1, -0.2, 0.3))),
    ).toEqual(Array.from(Float32Array.of(0.1, -0.2, 0.3)));
  });
});

describe("a browser that refuses a microphone at another rate than the device's", () => {
  test("starts the call, and the line hears the microphone at 16 kHz", async () => {
    const hook = renderHook(() => usePlaygroundCall("7"));
    act(() => void hook.result.current.start());
    await until(
      "the line to ring",
      () => hook.result.current.call.state === "ringing",
    );
    const ws = sockets[0] as unknown as {
      readyState: number;
      send: (data: string) => void;
      onmessage: (msg: { data: string }) => void;
    };
    const sent: string[] = [];
    ws.send = (data) => sent.push(data);
    ws.readyState = 1;
    act(() => ws.onmessage({ data: JSON.stringify({ event: "ready" }) }));
    const frame = new Float32Array(1024).fill(0.5);
    for (let i = 0; i < 3; i++)
      nodes[0]?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => frame },
      });
    const media = sent
      .map((s) => JSON.parse(s) as { event: string; payload: string })
      .filter((f) => f.event === "media");
    const samples = media.reduce((n, f) => n + atob(f.payload).length / 2, 0);
    // Three 1024-sample frames at 48 kHz are 1024 samples at 16 kHz.
    expect(samples).toBe(1024);
    // The meter reads the microphone as it came, at the device's rate.
    await until(
      "the microphone meter",
      () => hook.result.current.meters.mic === 0.5,
    );
    hook.unmount();
  });

  test("an audio graph the browser cannot build fails the call, and releases the microphone", async () => {
    refuseGraph = true;
    const hook = renderHook(() => usePlaygroundCall("7"));
    act(() => void hook.result.current.start());
    await until(
      "the call to fail",
      () => hook.result.current.call.state === "failed",
    );
    expect(hook.result.current.call).toMatchObject({ problem: "audio" });
    expect(stopped.count).toBeGreaterThan(0);
    expect(contexts[0]?.closed).toBe(true);
    expect(sockets).toHaveLength(0);
  });
});
