import { describe, expect, test } from "bun:test";
import type { ModelFallbackState } from "@/client/pages/agents/BehaviorTab";
import {
  fallbackIsConfigured,
  fallbackModelIsMissing,
  modelFallbackReaderKeys,
  modelFallbackToForm,
  modelFallbackToStored,
} from "@/client/pages/agents/modelFallbackFormState";
import {
  overrideBaseUrlInvalid,
  overrideBaseUrlUnsupported,
} from "@/client/pages/agents/modelOverrideForm";
import {
  hasModelFallback,
  readModelFallbackConfig,
} from "@/graph/fallback-settings";

// The Behavior save REPLACES the whole `modelFallback` block with what the form holds, so a field
// the form does not carry is not merely un-editable: it is DELETED on the next save. That already
// happened once to `tts.baseURL`, which REST and MCP accept and the form did not.
describe("agent editor fallback-provider round-trip", () => {
  test("a configured fallback survives form → stored → form", () => {
    const stored = {
      modelFallback: {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        credentialRef: "vault:7",
        baseURL: "https://proxy.example/v1",
      },
    };
    const round = modelFallbackToStored(modelFallbackToForm(stored));
    expect(round).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      credentialRef: "vault:7",
      baseURL: "https://proxy.example/v1",
    });
  });

  // An agent that never named a fallback has to come back as nulls, not blanks, so it stays
  // byte-comparable with one that was never opened in the editor.
  test("an untouched bag round-trips to nulls, not blanks", () => {
    expect(modelFallbackToStored(modelFallbackToForm({}))).toEqual({
      provider: null,
      model: null,
      credentialRef: null,
      baseURL: null,
    });
  });

  test("the form carries every key the reader produces", () => {
    const written = Object.keys(
      modelFallbackToStored(modelFallbackToForm({})),
    ).sort();
    expect(written).toEqual(modelFallbackReaderKeys());
    expect(modelFallbackReaderKeys()).toEqual(
      Object.keys(readModelFallbackConfig({})).sort(),
    );
  });

  // The half-named state, which is the one this block's semantics turn on: it stores cleanly, it
  // reads back, and it builds nothing. The round-trip has to preserve it rather than complete it
  // from the agent's own config, or the editor would show a fallback the runtime refuses.
  test("a provider with no model round-trips as exactly that", () => {
    const round = modelFallbackToStored(
      modelFallbackToForm({ modelFallback: { provider: "anthropic" } }),
    );
    expect(round.provider).toBe("anthropic");
    expect(round.model).toBeNull();
  });
});

// The Behavior tab's Save is blocked while either of these holds, and the fallback's fields live
// behind a provider select the operator can set back to "no fallback", which hides them. Same
// precondition the summariser's override carries, over the same shared helper.
const AGENT = { provider: "openai", credentialRef: "vault:1", baseURL: "" };
const BROKEN = {
  provider: "openai-compatible",
  model: "local-small",
  credentialRef: "",
  baseURL: "llama:8080",
};

describe("the fallback's endpoint never freezes a hidden section", () => {
  test("with a fallback configured, a broken endpoint blocks the save", () => {
    expect(overrideBaseUrlInvalid(BROKEN, AGENT, null, true)).toBe(true);
  });

  // The state that has to stay reachable: a fallback saved through REST or MCP that cannot run, on
  // an agent whose operator then clears the provider. Reporting it would freeze the tab with
  // nothing on screen to explain it, including the save that clears the block.
  test("with no fallback configured, the same bag reports nothing", () => {
    expect(overrideBaseUrlInvalid(BROKEN, AGENT, null, false)).toBe(false);
  });

  test("the unsupported-endpoint half is gated the same way", () => {
    const onKeyedVendor = {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      credentialRef: "vault:9",
      baseURL: "",
    };
    expect(
      overrideBaseUrlUnsupported(
        onKeyedVendor,
        AGENT,
        "https://proxy.example/v1",
        true,
      ),
    ).toBe(true);
    expect(
      overrideBaseUrlUnsupported(
        onKeyedVendor,
        AGENT,
        "https://proxy.example/v1",
        false,
      ),
    ).toBe(false);
  });
});

// THE EDITOR'S TWO VERDICTS, as a table. They answer the same question the backend answers, and a
// divergence is silent in both directions: `fallbackIsConfigured` gates the endpoint checks, so
// answering NO switches off the checks that block the save; `fallbackModelIsMissing` renders the
// field error AND blocks it. Review found both halves of that, one round apart.
describe("the editor's fallback verdicts", () => {
  const form = (over: Partial<ModelFallbackState>): ModelFallbackState => ({
    provider: "",
    model: "",
    credentialRef: "",
    baseURL: "",
    ...over,
  });

  const ROWS: Array<{
    name: string;
    state: Partial<ModelFallbackState>;
    configured: boolean;
    modelMissing: boolean;
  }> = [
    {
      name: "nothing picked",
      state: {},
      configured: false,
      modelMissing: false,
    },
    {
      name: "provider and model",
      state: { provider: "anthropic", model: "claude-haiku-4-5" },
      configured: true,
      modelMissing: false,
    },
    {
      name: "a provider that needs a model, without one",
      state: { provider: "anthropic" },
      configured: false,
      modelMissing: true,
    },
    // THE ROW THE REVIEW WAS ABOUT: the backend calls this configured, so the editor must too, or
    // it stops checking the endpoint this provider cannot run without.
    {
      name: "openai-compatible with no model",
      state: { provider: "openai-compatible", baseURL: "https://llm.local/v1" },
      configured: true,
      modelMissing: false,
    },
    {
      name: "openai-compatible with no model and no endpoint",
      state: { provider: "openai-compatible" },
      configured: true,
      modelMissing: false,
    },
    {
      name: "a model with no provider is no destination",
      state: { model: "claude-haiku-4-5" },
      configured: false,
      modelMissing: false,
    },
    {
      name: "whitespace is not a name",
      state: { provider: "  ", model: "  " },
      configured: false,
      modelMissing: false,
    },
    {
      name: "a real provider with a whitespace model still owes one",
      state: { provider: "openai", model: "   " },
      configured: false,
      modelMissing: true,
    },
  ];

  for (const row of ROWS) {
    test(`${row.name}: configured=${row.configured}, modelMissing=${row.modelMissing}`, () => {
      expect(fallbackIsConfigured(form(row.state))).toBe(row.configured);
      expect(fallbackModelIsMissing(form(row.state))).toBe(row.modelMissing);
    });
  }

  // The editor and the backend answer the SAME question, so they are checked against each other
  // rather than each against its own idea of the rule.
  test("configured agrees with the backend's own predicate, row by row", () => {
    for (const row of ROWS) {
      const f = form(row.state);
      const stored = modelFallbackToStored(f);
      expect(fallbackIsConfigured(f)).toBe(
        hasModelFallback(readModelFallbackConfig({ modelFallback: stored })),
      );
    }
  });
});
