import { describe, expect, test } from "bun:test";
import {
  readTtsFormState,
  type TtsFormState,
  ttsNormalizerBaseUrlInvalid,
  ttsNormalizerEffectiveSource,
  ttsNormalizerNeedsOwnCredential,
  ttsNormalizerProviderChanged,
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

describe("switching the rewrite provider", () => {
  // The base URL is the one that bites: its field only renders for openai-compatible, so a leftover
  // value keeps steering the new provider's client at an endpoint the operator can no longer see.
  test("drops every field that belonged to the previous provider", () => {
    const form = readTtsFormState(SAVED, true);
    const next = ttsNormalizerProviderChanged(form, "openrouter");
    expect(next.normalizeProvider).toBe("openrouter");
    expect(next.normalizeModel).toBe("");
    expect(next.normalizeCredentialRef).toBe("");
    expect(next.normalizeBaseURL).toBe("");
  });

  test("leaves the rest of the block alone", () => {
    const form = readTtsFormState(SAVED, true);
    const next = ttsNormalizerProviderChanged(form, "openrouter");
    expect(next.voice).toBe(form.voice);
    expect(next.credentialRef).toBe(form.credentialRef);
    expect(next.speed).toBe(form.speed);
  });
});

// Which configurations the editor must DEMAND a key for. It mirrors `resolveNormalizeModel`, which
// refuses a switched provider without one rather than run it on the agent's key: the runtime failure
// is silent (the audio still goes out, unrewritten), so the field marking is the only warning the
// operator gets before saving.
describe("does the rewrite need a credential of its own", () => {
  const cases: Array<[string, string, boolean]> = [
    // Inheriting outright: the block does not even render.
    ["", "openai", false],
    // The same vendor, named explicitly, which is how a separate key gets attached. Optional.
    ["openai", "openai", false],
    // A vendor the agent does not use: nothing is inherited, so the key decides whether it runs.
    ["anthropic", "openai", true],
    // Compared against the AGENT's provider, never a hardcoded one. Both rows fail if this is
    // written as `!== "openai"`.
    ["openai-compatible", "openai-compatible", false],
    ["openai", "openai-compatible", true],
    // What a cleared field actually stores.
    ["   ", "openai", false],
  ];
  for (const [normalizeProvider, agentProvider, want] of cases) {
    test(`${normalizeProvider || "(inherited)"} on a ${agentProvider} agent → ${want}`, () => {
      expect(
        ttsNormalizerNeedsOwnCredential(normalizeProvider, agentProvider),
      ).toBe(want);
    });
  }
});

// What the rewrite's model picker authenticates with. It lists models by CALLING the provider, so a
// picker handed only the rewrite's own (empty) fields shows "select a credential" and no models at
// all — on the very change this feature exists for, where the key is inherited on purpose.
describe("the rewrite's effective credential and endpoint", () => {
  const AGENT = {
    provider: "openai",
    credentialRef: "vault:1",
    baseURL: "",
  };
  const form = (over: Partial<TtsFormState> = {}) => ({
    ...readTtsFormState({ mode: "mirror" }, true),
    ...over,
  });

  test("the same provider with no key of its own inherits the agent's", () => {
    expect(
      ttsNormalizerEffectiveSource(
        form({ normalizeProvider: "openai" }),
        AGENT,
        null,
      ),
    ).toEqual({ credentialRef: "vault:1", baseURL: "" });
  });

  test("its own key wins over the agent's on the same provider", () => {
    expect(
      ttsNormalizerEffectiveSource(
        form({
          normalizeProvider: "openai",
          normalizeCredentialRef: "vault:9",
        }),
        AGENT,
        null,
      ).credentialRef,
    ).toBe("vault:9");
  });

  // The mirror of the resolver's rule: a switched provider inherits NOTHING, so an empty result is
  // correct here and the picker showing no models is the honest outcome.
  test("a different provider never borrows the agent's key or endpoint", () => {
    expect(
      ttsNormalizerEffectiveSource(
        form({ normalizeProvider: "anthropic" }),
        { ...AGENT, baseURL: "https://gw.internal/v1" },
        null,
      ),
    ).toEqual({ credentialRef: "", baseURL: "" });
  });

  test("the selected credential's own endpoint wins over the typed field", () => {
    expect(
      ttsNormalizerEffectiveSource(
        form({
          normalizeProvider: "openai-compatible",
          normalizeCredentialRef: "vault:9",
          normalizeBaseURL: "https://typed.example.com/v1",
        }),
        AGENT,
        "https://from-credential.example.com/v1",
      ).baseURL,
    ).toBe("https://from-credential.example.com/v1");
  });

  test("the agent's endpoint is inherited on the same provider", () => {
    expect(
      ttsNormalizerEffectiveSource(
        form({ normalizeProvider: "openai-compatible" }),
        {
          provider: "openai-compatible",
          credentialRef: "vault:1",
          baseURL: "http://llama:8080/v1",
        },
        null,
      ).baseURL,
    ).toBe("http://llama:8080/v1");
  });
});

// An openai-compatible endpoint with no base URL is refused by createChatModel, and the rewrite is
// then skipped as `model_not_runnable` on every audio reply, silently. The agent's own model field
// is guarded the same way, so this is the guard the rewrite's field was missing.
describe("the rewrite's endpoint has to be usable before saving", () => {
  const valid = (raw: string) => /^https?:\/\/.+/.test(raw);
  const form = (over: Partial<TtsFormState> = {}) => ({
    ...readTtsFormState({ mode: "mirror" }, true),
    ...over,
  });
  const AGENT = { provider: "openai", credentialRef: "vault:1", baseURL: "" };

  test("openai-compatible with nothing anywhere blocks the save", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalizeProvider: "openai-compatible" }),
        AGENT,
        null,
        valid,
      ),
    ).toBe(true);
  });

  test("a typed endpoint clears it", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({
          normalizeProvider: "openai-compatible",
          normalizeBaseURL: "http://llama:8080/v1",
        }),
        AGENT,
        null,
        valid,
      ),
    ).toBe(false);
  });

  test("an endpoint carried by the credential clears it", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalizeProvider: "openai-compatible" }),
        AGENT,
        "https://from-credential.example.com/v1",
        valid,
      ),
    ).toBe(false);
  });

  // Inheriting from an openai-compatible AGENT is legitimate and already guaranteed by the General
  // tab's own check, so flagging it here would block a save that is perfectly fine.
  test("inheriting the agent's own endpoint is not flagged", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalizeProvider: "openai-compatible" }),
        {
          provider: "openai-compatible",
          credentialRef: "vault:1",
          baseURL: "http://llama:8080/v1",
        },
        null,
        valid,
      ),
    ).toBe(false);
  });

  test("any other provider is never flagged", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalizeProvider: "anthropic" }),
        AGENT,
        null,
        valid,
      ),
    ).toBe(false);
  });

  test("the rewrite turned off is never flagged", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalize: false, normalizeProvider: "openai-compatible" }),
        AGENT,
        null,
        valid,
      ),
    ).toBe(false);
  });
});
