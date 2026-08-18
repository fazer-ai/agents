import { describe, expect, test } from "bun:test";
import {
  STT_DEFAULT_MODEL,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  TTS_PROVIDERS,
  VISION_DEFAULT_MODEL,
} from "@/client/lib/providerDefaults";
import { getSttProvider, STT_PROVIDER_NAMES } from "@/modules/stt/providers";
import { getTtsProvider, TTS_PROVIDER_NAMES } from "@/modules/tts/providers";
import {
  getVisionProvider,
  VISION_PROVIDER_NAMES,
} from "@/modules/vision/providers";

// The client placeholder mirror (src/client/lib/providerDefaults.ts) must stay in lockstep with the
// server provider registries' defaults — otherwise the "default model" placeholder lies. This test
// fails the moment a server default changes without the mirror being updated.
describe("provider defaults mirror", () => {
  test("STT default models match the registry for every provider", () => {
    for (const name of STT_PROVIDER_NAMES) {
      expect(STT_DEFAULT_MODEL[name]).toBe(getSttProvider(name)?.defaultModel);
    }
  });

  test("Vision default models match the registry for every provider", () => {
    for (const name of VISION_PROVIDER_NAMES) {
      expect(VISION_DEFAULT_MODEL[name]).toBe(
        getVisionProvider(name)?.defaultModel,
      );
    }
  });

  test("TTS default model + voice match the registry for every provider", () => {
    for (const name of TTS_PROVIDER_NAMES) {
      expect(TTS_DEFAULT_MODEL[name]).toBe(getTtsProvider(name)?.defaultModel);
      expect(TTS_DEFAULT_VOICE[name]).toBe(getTtsProvider(name)?.defaultVoice);
    }
  });

  // Equality in BOTH directions, unlike the loops above: this list is not only what the editor
  // offers, it is what the form reader accepts from a stored bag. An entry the registry does not
  // have would be waved through here and then fall back to openai at synthesis time, which is a
  // voice note that never arrives.
  test("the editor's TTS provider list is exactly the registry's", () => {
    expect([...TTS_PROVIDERS].sort().join(",")).toBe(
      [...TTS_PROVIDER_NAMES].sort().join(","),
    );
  });
});
