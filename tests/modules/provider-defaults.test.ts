import { describe, expect, test } from "bun:test";
import {
  STT_DEFAULT_MODEL,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_VOICE,
  TTS_NORMALIZE_DEFAULT,
  VISION_DEFAULT_MODEL,
} from "@/client/lib/providerDefaults";
import { getSttProvider, STT_PROVIDER_NAMES } from "@/modules/stt/providers";
import { getTtsProvider, TTS_PROVIDER_NAMES } from "@/modules/tts/providers";
import { TTS_DEFAULTS } from "@/modules/tts/settings";
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

  // The editor decides from this whether an agent that never saved the flag shows the speech rewrite
  // as on. Drift here means the screen and the runtime disagree about what an untouched agent does.
  test("the speech-rewrite default matches the settings reader", () => {
    expect(TTS_NORMALIZE_DEFAULT).toBe(TTS_DEFAULTS.normalize);
  });
});
