import { describe, expect, test } from "bun:test";
import {
  type AgentModelSource,
  readTtsFormState,
  type TtsFormState,
  ttsNormalizerBaseUrlInvalid,
  ttsNormalizerBaseUrlUnsupported,
  ttsNormalizerNeedsOwnCredential,
  ttsNormalizerOverridePicked,
  ttsNormalizerPickerSource,
  ttsNormalizerProviderChanged,
  ttsSettingsFrom,
} from "@/client/pages/agents/ttsFormState";
import { readTtsConfig } from "@/modules/tts/settings";

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
    const form = readTtsFormState(SAVED);
    expect(ttsSettingsFrom(form)).toEqual(SAVED);
  });

  test("every key the settings reader knows about is carried by the form", () => {
    // The reader is the authority on what an agent can hold; anything it reads and the form drops is
    // a field the editor silently deletes.
    const saved = ttsSettingsFrom(readTtsFormState(SAVED));
    for (const key of Object.keys(readTtsConfig({ tts: SAVED }))) {
      expect(`${key}:${key in saved}`).toBe(`${key}:true`);
    }
  });

  test("an unset numeric knob round-trips as null, never as 0", () => {
    const form = readTtsFormState({ mode: "mirror" });
    const out = ttsSettingsFrom(form);
    expect(out.stability).toBeNull();
    expect(out.speed).toBeNull();
    expect(out.normalizeBaseURL).toBeNull();
  });

  test("an agent with no stored rewrite flag picks up the shipped default", () => {
    expect(readTtsFormState({ mode: "mirror" }).normalize).toBe(true);
    expect(
      readTtsFormState({ mode: "mirror", normalize: false }).normalize,
    ).toBe(false);
  });
});

// The knobs are clamped by the READER at runtime, so a form that stores the raw number leaves the
// editor showing a value synthesis never uses — and showing it again on the next load, since the
// form reads the stored bag directly rather than through the reader.
describe("voice knobs are stored at the value that will actually be used", () => {
  const knobs = (over: Partial<TtsFormState>) =>
    ttsSettingsFrom({ ...readTtsFormState({ mode: "mirror" }), ...over });

  test("an overshot slider is stored clamped, not raw", () => {
    expect(knobs({ stability: "9", speed: "12" })).toMatchObject({
      stability: 1,
      speed: 4,
    });
  });

  test("an undershot one too", () => {
    expect(knobs({ style: "-3", speed: "0.05" })).toMatchObject({
      style: 0,
      speed: 0.25,
    });
  });

  // Clamping must not turn "leave it to the voice" into a number: null is a value here, and the
  // lowest end of the band is NOT the same instruction.
  test("a blank knob still clears to null", () => {
    expect(knobs({ stability: "", speed: "" })).toMatchObject({
      stability: null,
      speed: null,
    });
  });

  test("a value inside the band is untouched", () => {
    expect(knobs({ stability: "0.35", speed: "1.15" })).toMatchObject({
      stability: 0.35,
      speed: 1.15,
    });
  });
});

// Same rule as the knobs, on the two fields that decide whether the section is even coherent. The
// runtime reader allowlists both; a form that does not shows an audio configuration for an agent
// that sends no audio, and saves the unusable value straight back.
describe("mode and provider are allowlisted the way the runtime allowlists them", () => {
  test("a mode the runtime does not accept reads as never", () => {
    expect(readTtsFormState({ mode: "Mirror" }).mode).toBe("never");
    expect(readTtsFormState({ mode: "mirror" }).mode).toBe("mirror");
  });

  test("a provider the runtime does not accept reads as the default", () => {
    expect(readTtsFormState({ provider: "Elevenlabs" }).provider).toBe(
      "openai",
    );
    expect(readTtsFormState({ provider: "elevenlabs" }).provider).toBe(
      "elevenlabs",
    );
  });

  // And the reader agrees with the runtime's, field by field, on the same bag: this is the
  // invariant, the two above are just the cases that broke it.
  test("both fields agree with readTtsConfig on the same bag", () => {
    for (const bag of [
      { mode: "Mirror", provider: "Elevenlabs" },
      { mode: "preference", provider: "openrouter" },
      { mode: "", provider: "" },
      { mode: 7, provider: null },
    ]) {
      const form = readTtsFormState(bag);
      const runtime = readTtsConfig({ tts: bag });
      expect(`${form.mode}/${form.provider}`).toBe(
        `${runtime.mode}/${runtime.provider}`,
      );
    }
  });
});

// The other half of the same rule, and the only half the editor cannot fix by saving: REST and
// import store the raw number, so the form has to show what synthesis will ACTUALLY do with it.
describe("voice knobs are displayed at the value that will actually be used", () => {
  const form = (over: Record<string, unknown>) =>
    readTtsFormState({ mode: "mirror", ...over });

  test("a bag written out of range is displayed clamped", () => {
    expect(form({ speed: 9, stability: -3 })).toMatchObject({
      speed: "4",
      stability: "0",
    });
  });

  test("and one written in range is displayed as it is", () => {
    expect(form({ speed: 1.15, style: 0.2 })).toMatchObject({
      speed: "1.15",
      style: "0.2",
    });
  });

  // A knob nobody set is not the bottom of the band: it stays blank, which is what hands the
  // decision back to the voice.
  test("an absent knob stays blank", () => {
    expect(form({})).toMatchObject({ speed: "", stability: "", style: "" });
  });
});

describe("switching the rewrite provider", () => {
  // The base URL is the one that bites: its field only renders for openai-compatible, so a leftover
  // value keeps steering the new provider's client at an endpoint the operator can no longer see.
  test("drops every field that belonged to the previous provider", () => {
    const form = readTtsFormState(SAVED);
    const next = ttsNormalizerProviderChanged(form, "openrouter");
    expect(next.normalizeProvider).toBe("openrouter");
    expect(next.normalizeModel).toBe("");
    expect(next.normalizeCredentialRef).toBe("");
    expect(next.normalizeBaseURL).toBe("");
  });

  test("leaves the rest of the block alone", () => {
    const form = readTtsFormState(SAVED);
    const next = ttsNormalizerProviderChanged(form, "openrouter");
    expect(next.voice).toBe(form.voice);
    expect(next.credentialRef).toBe(form.credentialRef);
    expect(next.speed).toBe(form.speed);
  });
});

// Picking a model or a key pins the vendor it was picked from, so the editor can never save the
// configuration the resolver refuses (`override_without_provider`). Both pickers call this, which is
// why it is one function and not two copies of an inline ternary in JSX.
describe("picking an override pins the vendor it came from", () => {
  const base = () =>
    readTtsFormState({ mode: "mirror", normalizeProvider: "" });

  test("picking a model on an inherited provider names the agent's", () => {
    const next = ttsNormalizerOverridePicked(
      base(),
      "normalizeModel",
      "gpt-4o-mini",
      "openai",
    );
    expect(next.normalizeModel).toBe("gpt-4o-mini");
    expect(next.normalizeProvider).toBe("openai");
  });

  test("picking a key on an inherited provider names the agent's", () => {
    const next = ttsNormalizerOverridePicked(
      base(),
      "normalizeCredentialRef",
      "vault:9",
      "anthropic",
    );
    expect(next.normalizeCredentialRef).toBe("vault:9");
    expect(next.normalizeProvider).toBe("anthropic");
  });

  // The rewrite already points somewhere on purpose: the agent's provider is not the answer, and
  // overwriting it here would silently move the whole thing back to the agent's vendor.
  test("an explicit provider is never overwritten", () => {
    const next = ttsNormalizerOverridePicked(
      { ...base(), normalizeProvider: "anthropic" },
      "normalizeModel",
      "claude-haiku-4-5",
      "openai",
    );
    expect(next.normalizeProvider).toBe("anthropic");
  });

  // The complement, and the reason the pin is keyed on a NON-EMPTY value. Clearing the last override
  // hands the rewrite back to full inheritance; pinning here would freeze it on the agent's CURRENT
  // vendor instead, silently, and the resolver would then refuse it the next time the agent moved.
  test("clearing on an inherited provider does not pin anything", () => {
    const next = ttsNormalizerOverridePicked(
      base(),
      "normalizeModel",
      "",
      "openai",
    );
    expect(next.normalizeProvider).toBe("");
  });

  // Clearing is not a decision about the vendor, and a blank provider is strictly less informative:
  // unpinning here would re-create the very state the resolver refuses.
  test("clearing the field leaves the pinned provider alone", () => {
    const pinned = ttsNormalizerOverridePicked(
      base(),
      "normalizeModel",
      "gpt-4o-mini",
      "openai",
    );
    const cleared = ttsNormalizerOverridePicked(
      pinned,
      "normalizeModel",
      "",
      "openai",
    );
    expect(cleared.normalizeModel).toBe("");
    expect(cleared.normalizeProvider).toBe("openai");
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
  ...readTtsFormState({ mode: "mirror" }),
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
// An endpoint aimed at a provider that will never send it. Reachable from the editor in two clicks
// (pick a credential that carries one while the rewrite sits on a keyed vendor), and the request
// would leave for the vendor's public host with the key and the customer's text.
describe("an endpoint the provider cannot send", () => {
  test("a credential's endpoint on a keyed provider is unsupported", () => {
    expect(
      ttsNormalizerBaseUrlUnsupported(
        form({
          normalizeProvider: "openai",
          normalizeCredentialRef: "vault:9",
        }),
        OPENAI,
        "https://proxy.example.com/v1",
      ),
    ).toBe(true);
  });

  test("the same endpoint on openai-compatible is fine", () => {
    expect(
      ttsNormalizerBaseUrlUnsupported(
        form({
          normalizeProvider: "openai-compatible",
          normalizeCredentialRef: "vault:9",
        }),
        OPENAI,
        "https://proxy.example.com/v1",
      ),
    ).toBe(false);
  });

  // The agent's own endpoint is not the rewrite's doing: it lands wherever the agent's model lands.
  test("an endpoint inherited from the agent is never flagged", () => {
    expect(ttsNormalizerBaseUrlUnsupported(form(), LOCAL, null)).toBe(false);
  });

  // With audio off the whole block is hidden, and a hidden block must never freeze Save.
  test("audio off never reports it", () => {
    expect(
      ttsNormalizerBaseUrlUnsupported(
        form({
          mode: "never",
          normalizeProvider: "openai",
          normalizeCredentialRef: "vault:9",
        }),
        OPENAI,
        "https://proxy.example.com/v1",
      ),
    ).toBe(false);
  });
});

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

  // The block is HIDDEN with audio replies off, so blocking Save on it would freeze the whole
  // Behavior tab with nothing on screen to explain it — including the save that turns audio off.
  test("audio replies turned off is never flagged, whatever is left in the fields", () => {
    expect(
      ttsNormalizerBaseUrlInvalid(
        {
          ...form({ normalizeProvider: "openai-compatible" }),
          mode: "never",
        },
        OPENAI,
        null,
      ),
    ).toBe(false);
  });
});
