import { describe, expect, test } from "bun:test";
import {
  readTtsConfig,
  shouldReplyWithAudio,
  TTS_DEFAULTS,
} from "@/modules/tts/settings";

describe("readTtsConfig", () => {
  test("defaults to never / openai when absent", () => {
    expect(readTtsConfig(undefined)).toEqual(TTS_DEFAULTS);
    expect(readTtsConfig({ tts: {} })).toEqual(TTS_DEFAULTS);
    expect(readTtsConfig(undefined).mode).toBe("never");
  });

  test("accepts the three modes and rejects bogus", () => {
    expect(readTtsConfig({ tts: { mode: "mirror" } }).mode).toBe("mirror");
    expect(readTtsConfig({ tts: { mode: "preference" } }).mode).toBe(
      "preference",
    );
    expect(readTtsConfig({ tts: { mode: "bogus" } }).mode).toBe("never");
  });

  test("rejects an unknown provider", () => {
    expect(readTtsConfig({ tts: { provider: "elevenlabs" } }).provider).toBe(
      "elevenlabs",
    );
    expect(readTtsConfig({ tts: { provider: "nope" } }).provider).toBe(
      "openai",
    );
  });

  test("carries voice/model/credentialRef", () => {
    const c = readTtsConfig({
      tts: {
        mode: "mirror",
        voice: "Keren",
        model: "eleven_flash_v2_5",
        credentialRef: "el-key",
      },
    });
    expect(c.voice).toBe("Keren");
    expect(c.model).toBe("eleven_flash_v2_5");
    expect(c.credentialRef).toBe("el-key");
  });
});

// The speech rewrite ships ON. A stored value always wins over the default, which is precisely why
// the migration DELETES the key instead of writing true over it: an agent that saved `false` before
// the flip (which every editor save did, explicitly) must keep its choice, and an agent that never
// carried the key must pick the new default up.
describe("readTtsConfig — speech rewrite default", () => {
  test("an agent with no stored flag gets the new default", () => {
    expect(readTtsConfig({ tts: { mode: "mirror" } }).normalize).toBe(true);
    expect(readTtsConfig(undefined).normalize).toBe(TTS_DEFAULTS.normalize);
  });

  test("a stored false still wins", () => {
    expect(readTtsConfig({ tts: { normalize: false } }).normalize).toBe(false);
  });

  test("a non-boolean stored value is junk and falls back to the default", () => {
    expect(readTtsConfig({ tts: { normalize: "yes" } }).normalize).toBe(
      TTS_DEFAULTS.normalize,
    );
  });
});

describe("shouldReplyWithAudio", () => {
  test("never → always text", () => {
    expect(shouldReplyWithAudio("never", true, true)).toBe(false);
    expect(shouldReplyWithAudio("never", false, null)).toBe(false);
  });

  test("mirror → audio iff the customer sent audio", () => {
    expect(shouldReplyWithAudio("mirror", true, null)).toBe(true);
    expect(shouldReplyWithAudio("mirror", false, true)).toBe(false);
  });

  test("preference → follows the stored preference, mirrors when unknown", () => {
    expect(shouldReplyWithAudio("preference", false, true)).toBe(true);
    expect(shouldReplyWithAudio("preference", true, false)).toBe(false);
    expect(shouldReplyWithAudio("preference", true, null)).toBe(true);
    expect(shouldReplyWithAudio("preference", false, null)).toBe(false);
  });
});
