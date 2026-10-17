import { describe, expect, test } from "bun:test";
import {
  speakerNow,
  voiceEndIn,
} from "@/client/pages/agents/usePlaygroundCall";

// The Playground's "who is talking" line reads the agent's VOICE, not its audio: the background sound
// plays the whole call, so a queue of audio is not the agent talking. The levels are the ones measured
// on a call with the background on (around 0.01 RMS for the background, above 0.05 for the voice).

const RATE = 16_000;
const tone = (secs: number, amplitude: number) =>
  Float32Array.from(
    { length: Math.round(secs * RATE) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE),
  );
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("the agent's voice in its audio", () => {
  test("the background alone is no voice", () => {
    expect(voiceEndIn(tone(1, 0.02), 5)).toBeNull();
  });

  test("a voice ends where its loud part ends, on the audio clock", () => {
    const chunk = join(tone(0.5, 0.2), tone(0.5, 0.02));
    expect(voiceEndIn(chunk, 5)).toBeCloseTo(5.5, 2);
  });
});

describe("who the screen says is talking", () => {
  test("the agent while its voice plays, and a moment after", () => {
    expect(speakerNow(10, 9.5, 0)).toBe("agent");
    expect(speakerNow(10, 10.2, 0)).toBe("agent");
  });

  test("the operator once the agent's voice is over and the microphone hears them", () => {
    expect(speakerNow(10, 11, 0.3)).toBe("operator");
  });

  test("nobody in a silence, however long the background plays", () => {
    expect(speakerNow(10, 11, 0.01)).toBeNull();
  });
});
