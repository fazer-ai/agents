import { describe, expect, test } from "bun:test";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import {
  type NormalizeModelResolution,
  type NormalizeModelSource,
  resolveNormalizeModel,
} from "@/modules/tts/normalize-model";
import { readTtsConfig } from "@/modules/tts/settings";

// Decision table for WHICH model rewrites the reply for speech. Every row is a configuration an
// operator can actually save, and the column that matters is what reaches the provider.

const AGENT: NormalizeModelSource = {
  provider: "openai",
  model: "gpt-5",
  baseURL: null,
};

function resolve(tts: Record<string, unknown>, agent = AGENT) {
  return resolveNormalizeModel(readTtsConfig({ tts }), agent);
}

describe("resolveNormalizeModel", () => {
  const cases: Array<{
    name: string;
    tts: Record<string, unknown>;
    agent?: NormalizeModelSource;
    want: Partial<NormalizeModelResolution>;
  }> = [
    {
      // The default, and the only row that matters for an install upgrading into this feature:
      // nothing configured ⇒ everything inherited ⇒ byte-identical behavior to before.
      name: "nothing set inherits the agent's model wholesale",
      tts: { normalize: true },
      want: { provider: "openai", model: "gpt-5", baseURL: null },
    },
    {
      // The common case the feature exists for: same account, cheaper model.
      name: "a model alone keeps the agent's provider",
      tts: { normalize: true, normalizeModel: "gpt-4o-mini" },
      want: { provider: "openai", model: "gpt-4o-mini", baseURL: null },
    },
    {
      // Naming the same provider is what picking a separate credential on the same vendor looks
      // like. Swapping the key is not a request to swap the model, so the agent's model still wins.
      name: "the agent's OWN provider, named explicitly, still inherits the agent's model",
      tts: {
        normalize: true,
        normalizeProvider: "openai",
        normalizeCredentialRef: "vault:9",
      },
      want: { provider: "openai", model: "gpt-5", baseURL: null },
    },
    {
      // A vendor the agent does not use, with no key of its own. Running it on the agent's key would
      // TRANSMIT an OpenAI secret to Anthropic before failing auth, so it does not run at all.
      name: "a changed provider with no credential of its own is refused, not run on the agent's key",
      tts: { normalize: true, normalizeProvider: "anthropic" },
      want: {
        provider: "anthropic",
        runnable: false,
        reason: "provider_without_credential",
        useOwnCredential: false,
      },
    },
    {
      // With its own key, the change is legitimate. Inheriting "gpt-5" into Anthropic would send an
      // OpenAI model id there, so an unset model resolves to the NEW provider's default.
      name: "a changed provider with its own credential resolves that provider's default model",
      tts: {
        normalize: true,
        normalizeProvider: "anthropic",
        normalizeCredentialRef: "vault:9",
      },
      want: {
        provider: "anthropic",
        model: PROVIDER_DEFAULT_MODEL.anthropic ?? "",
        baseURL: null,
        runnable: true,
        useOwnCredential: true,
      },
    },
    {
      // The endpoint belongs to the OLD vendor as much as the key does: inheriting it would send the
      // new dedicated key to the agent's gateway.
      name: "a changed provider never inherits the agent's endpoint",
      tts: {
        normalize: true,
        normalizeProvider: "openrouter",
        normalizeCredentialRef: "vault:9",
      },
      agent: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "https://gw.internal/v1",
      },
      want: { provider: "openrouter", baseURL: null, runnable: true },
    },
    {
      name: "both set are both used",
      tts: {
        normalize: true,
        normalizeProvider: "google",
        normalizeModel: "gemini-2.5-flash",
        normalizeCredentialRef: "vault:9",
        normalizeBaseURL: "https://proxy.example.com/v1",
      },
      want: {
        provider: "google",
        model: "gemini-2.5-flash",
        baseURL: "https://proxy.example.com/v1",
      },
    },
    {
      // A provider that is not in the allowlist is junk, not an instruction: fall back rather than
      // hand an unknown name to createChatModel.
      name: "an unknown provider is ignored and the agent's is kept",
      tts: { normalize: true, normalizeProvider: "not-a-provider" },
      want: { provider: "openai", model: "gpt-5", baseURL: null },
    },
    {
      // openai-compatible's empty model is meaningful (the server picks), and that is exactly what
      // the agent-level config already carries, so inheriting it is right.
      name: "an openai-compatible agent with an empty model inherits the empty model",
      tts: { normalize: true },
      agent: {
        provider: "openai-compatible",
        model: "",
        baseURL: "http://llama:8080/v1",
      },
      want: {
        provider: "openai-compatible",
        model: "",
        baseURL: "http://llama:8080/v1",
      },
    },
    {
      name: "the baseURL falls back to the agent's when only the model is overridden",
      tts: { normalize: true, normalizeModel: "gpt-4o-mini" },
      agent: { ...AGENT, baseURL: "https://gw.example.com/v1" },
      want: {
        provider: "openai",
        model: "gpt-4o-mini",
        baseURL: "https://gw.example.com/v1",
      },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(resolve(c.tts, c.agent ?? AGENT)).toMatchObject(c.want);
    });
  }

  // Blank strings are what an editor field the operator cleared actually stores. They must read as
  // "unset", not as an empty model name going on the wire (the #94 failure).
  test("blank overrides read as unset, not as an empty model", () => {
    expect(
      resolve({ normalize: true, normalizeProvider: "  ", normalizeModel: "" }),
    ).toMatchObject({ provider: "openai", model: "gpt-5", baseURL: null });
  });
});
