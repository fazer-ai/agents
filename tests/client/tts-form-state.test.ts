import { describe, expect, test } from "bun:test";
import {
  type AgentModelSource,
  readTtsFormState,
  type TtsFormState,
  ttsNormalizerBaseUrlInvalid,
  ttsNormalizerNeedsOwnCredential,
  ttsNormalizerPickerSource,
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

// The editor's projections of `resolveNormalizeModel`. What they are worth is that they cannot
// disagree with the runtime: every one of them asks the resolver rather than re-deriving the rule.
// The exhaustive table for the rule itself lives in tests/modules/tts-normalize-model.test.ts.

const OPENAI: AgentModelSource = {
  provider: "openai",
  credentialRef: "vault:1",
  baseURL: "",
};
const LOCAL: AgentModelSource = {
  provider: "openai-compatible",
  credentialRef: "vault:1",
  baseURL: "http://llama:8080/v1",
};
const form = (over: Partial<TtsFormState> = {}): TtsFormState => ({
  ...readTtsFormState({ mode: "mirror" }, true),
  ...over,
});

// Whether the API key field is marked required. The runtime failure it warns about is SILENT (the
// audio still goes out, unrewritten), so this marking is the only warning before saving.
describe("does the rewrite need a credential of its own", () => {
  const cases: Array<[string, TtsFormState, AgentModelSource, boolean]> = [
    // Inheriting outright: the block does not even render.
    ["inherited", form(), OPENAI, false],
    // The same vendor, named explicitly, which is how a separate key gets attached. Optional.
    [
      "the agent's own provider",
      form({ normalizeProvider: "openai" }),
      OPENAI,
      false,
    ],
    // A vendor the agent does not use: nothing is inherited, so the key decides whether it runs.
    [
      "a switched provider",
      form({ normalizeProvider: "anthropic" }),
      OPENAI,
      true,
    ],
    // Compared against the AGENT's provider, never a hardcoded one.
    [
      "openai-compatible on a local agent",
      form({ normalizeProvider: "openai-compatible" }),
      LOCAL,
      false,
    ],
    [
      "openai on a local agent",
      form({ normalizeProvider: "openai" }),
      LOCAL,
      true,
    ],
    // A local endpoint authenticates by its URL, so no key is demanded even though the provider
    // changed. Demanding one here would force a dummy vault entry for a keyless server.
    [
      "a switched openai-compatible WITH an endpoint",
      form({
        normalizeProvider: "openai-compatible",
        normalizeBaseURL: "http://llama:8080/v1",
      }),
      OPENAI,
      false,
    ],
    // Not "needs a credential": it needs an ENDPOINT, and that is a different message and a
    // different field. The base-URL check below is what catches it.
    [
      "a switched openai-compatible with NO endpoint",
      form({ normalizeProvider: "openai-compatible" }),
      OPENAI,
      false,
    ],
  ];
  for (const [name, tts, agent, want] of cases) {
    test(`${name} → ${want}`, () => {
      expect(ttsNormalizerNeedsOwnCredential(tts, agent, null)).toBe(want);
    });
  }

  test("a credential carried by the picker satisfies the demand", () => {
    expect(
      ttsNormalizerNeedsOwnCredential(
        form({
          normalizeProvider: "anthropic",
          normalizeCredentialRef: "vault:9",
        }),
        OPENAI,
        null,
      ),
    ).toBe(false);
  });
});

// What the model picker authenticates with to list models. It calls the provider, so being handed
// only the rewrite's own (deliberately empty) fields left it with nothing on the one change this
// feature exists for, and it answered "select a credential" with an empty list.
describe("what the model picker queries with", () => {
  test("the same provider with no key of its own borrows the agent's", () => {
    expect(
      ttsNormalizerPickerSource(
        form({ normalizeProvider: "openai" }),
        OPENAI,
        null,
      ),
    ).toEqual({
      credentialRef: "vault:1",
      baseURL: "",
    });
  });

  test("its own key wins over the agent's", () => {
    expect(
      ttsNormalizerPickerSource(
        form({
          normalizeProvider: "openai",
          normalizeCredentialRef: "vault:9",
        }),
        OPENAI,
        null,
      ).credentialRef,
    ).toBe("vault:9");
  });

  // The mirror of the resolver's refusal: nothing is inherited, so an empty result is the honest
  // outcome and the picker saying "select a credential" is correct here.
  test("a switched provider with no key of its own borrows nothing", () => {
    expect(
      ttsNormalizerPickerSource(
        form({ normalizeProvider: "anthropic" }),
        { ...OPENAI, baseURL: "https://gw.internal/v1" },
        null,
      ),
    ).toEqual({ credentialRef: "", baseURL: "" });
  });

  test("the credential's own endpoint is what the picker calls", () => {
    expect(
      ttsNormalizerPickerSource(
        form({
          normalizeProvider: "openai-compatible",
          normalizeCredentialRef: "vault:9",
          normalizeBaseURL: "http://typed:8080/v1",
        }),
        OPENAI,
        "https://from-credential.example.com/v1",
      ).baseURL,
    ).toBe("https://from-credential.example.com/v1");
  });

  test("the agent's endpoint is inherited on the same provider", () => {
    expect(
      ttsNormalizerPickerSource(
        form({ normalizeProvider: "openai-compatible" }),
        LOCAL,
        null,
      ).baseURL,
    ).toBe("http://llama:8080/v1");
  });
});

// An openai-compatible endpoint with no base URL is refused by createChatModel, and the rewrite is
// then skipped as `model_not_runnable` on every audio reply, silently. The editor is stricter than
// the runtime here on purpose: a half-typed URL is refused before the save.
describe("the rewrite's endpoint has to be usable before saving", () => {
  test("openai-compatible with nothing anywhere blocks the save", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalizeProvider: "openai-compatible" }),
        OPENAI,
        null,
      ),
    ).toBe(true);
  });

  test("a half-typed endpoint blocks it too, where the runtime would have tried", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({
          normalizeProvider: "openai-compatible",
          normalizeBaseURL: "llama:8080",
        }),
        OPENAI,
        null,
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
        OPENAI,
        null,
      ),
    ).toBe(false);
  });

  test("an endpoint carried by the credential clears it", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalizeProvider: "openai-compatible" }),
        OPENAI,
        "https://from-credential.example.com/v1",
      ),
    ).toBe(false);
  });

  // Inheriting from an openai-compatible AGENT is legitimate and already guaranteed by the General
  // tab's own check, so flagging it here would block a save that is perfectly fine.
  test("inheriting the agent's own endpoint is not flagged", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalizeProvider: "openai-compatible" }),
        LOCAL,
        null,
      ),
    ).toBe(false);
  });

  test("any other provider is never flagged", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalizeProvider: "anthropic" }),
        OPENAI,
        null,
      ),
    ).toBe(false);
  });

  test("the rewrite turned off is never flagged", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        form({ normalize: false, normalizeProvider: "openai-compatible" }),
        OPENAI,
        null,
      ),
    ).toBe(false);
  });
});
