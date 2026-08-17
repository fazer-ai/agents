import { describe, expect, test } from "bun:test";
import {
  readTtsFormState,
  ttsSettingsFrom,
} from "@/client/pages/agents/ttsFormState";
import { readTtsConfig, TTS_DEFAULTS } from "@/modules/tts/settings";

// The Behavior save REPLACES the whole `tts` block with what the form holds, so any field the form
// does not carry is deleted on the next save. `normalizeBaseURL` was exactly that: settable over REST
// and MCP, and wiped the first time an operator saved the Behavior tab. These tests are over the
// round-trip rather than over that one field, so the next field cannot be added silently either.

// Every knob set to a NON-default value, so a field that fails to survive shows up as a difference
// rather than as a coincidence.
const SAVED = {
  mode: "preference",
  provider: "elevenlabs",
  model: "eleven_turbo_v2_5",
  voice: "Rachel",
  credentialRef: "vault:11",
  baseURL: "https://tts-proxy.example.com/v1",
  normalize: false,
  normalizeProvider: "openai-compatible",
  normalizeModel: "llama-3.1-8b",
  normalizeCredentialRef: "vault:12",
  normalizeBaseURL: "https://api.groq.com/openai/v1",
  stability: 0.35,
  similarityBoost: 0.8,
  style: 0.2,
  speed: 1.5,
  speakerBoost: false,
};

describe("agent editor TTS round-trip", () => {
  test("an agent's saved block survives load → save unchanged", () => {
    const form = readTtsFormState(SAVED, TTS_DEFAULTS.normalize);
    expect(ttsSettingsFrom(form)).toEqual(SAVED);
  });

  test("every key the settings reader knows about is carried by the form", () => {
    // The reader is the authority on what an agent can hold; anything it reads and the form drops is
    // a field the editor silently deletes.
    const saved = ttsSettingsFrom(readTtsFormState(SAVED, true));
    for (const key of Object.keys(readTtsConfig({ tts: SAVED }))) {
      expect(`${key}:${key in saved}`).toBe(`${key}:true`);
    }
  });

  test("an unset numeric knob round-trips as null, never as 0", () => {
    const form = readTtsFormState({ mode: "mirror" }, true);
    const out = ttsSettingsFrom(form);
    expect(out.stability).toBeNull();
    expect(out.speed).toBeNull();
    expect(out.normalizeBaseURL).toBeNull();
  });

  test("an agent with no stored rewrite flag picks up the shipped default", () => {
    expect(readTtsFormState({ mode: "mirror" }, true).normalize).toBe(true);
    expect(
      readTtsFormState({ mode: "mirror", normalize: false }, true).normalize,
    ).toBe(false);
  });
});
