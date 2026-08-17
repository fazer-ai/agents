import { describe, expect, test } from "bun:test";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import {
  type NormalizeModelResolution,
  type NormalizeModelSource,
  resolveNormalizeModel,
} from "@/modules/tts/normalize-model";
import { readTtsConfig } from "@/modules/tts/settings";

// Decision table for the whole rewrite-model question: which provider and model, on WHOSE key, at
// which endpoint, and whether it runs at all. Every row is a configuration an operator can actually
// save (the editor guards some of them, REST and MCP write the settings bag directly), and the
// column that matters is what reaches the provider.
//
// The failure this table exists to make impossible: a secret belonging to one vendor arriving at
// another. Three separate review rounds found three different paths into it.

const AGENT: NormalizeModelSource = {
  provider: "openai",
  model: "gpt-5",
  baseURL: null,
};

function resolve(
  tts: Record<string, unknown>,
  agent = AGENT,
  ownCredentialBaseURL: string | null = null,
) {
  return resolveNormalizeModel(readTtsConfig({ tts }), agent, {
    ownCredentialBaseURL,
  });
}

describe("resolveNormalizeModel", () => {
  const cases: Array<{
    name: string;
    tts: Record<string, unknown>;
    agent?: NormalizeModelSource;
    ownCredentialBaseURL?: string | null;
    want: Partial<NormalizeModelResolution>;
  }> = [
    {
      // The default, and the only row that matters for an install upgrading into this feature:
      // nothing configured ⇒ everything inherited ⇒ byte-identical behavior to before.
      name: "nothing set inherits the agent's model wholesale, on the agent's key",
      tts: { normalize: true },
      want: {
        provider: "openai",
        model: "gpt-5",
        baseURL: null,
        runnable: true,
        credential: "agent",
      },
    },
    {
      // The common case the feature exists for: same account, cheaper model.
      name: "a model alone keeps the agent's provider and key",
      tts: { normalize: true, normalizeModel: "gpt-4o-mini" },
      want: { provider: "openai", model: "gpt-4o-mini", credential: "agent" },
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
      want: { provider: "openai", model: "gpt-5", credential: "own" },
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
        credential: "none",
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
        credential: "own",
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
        credential: "own",
      },
    },
    {
      // A name we do not support is NOT an instruction to fall back: falling back to the agent's
      // provider while keeping the dedicated credential would hand that key to a vendor it does not
      // belong to, which is how a typo in a REST payload becomes a leak.
      name: "an unknown provider is refused outright, never resolved to the agent's",
      tts: { normalize: true, normalizeProvider: "anthropik" },
      want: { runnable: false, reason: "provider_unknown", credential: "none" },
    },
    {
      name: "an unknown provider with a dedicated key is refused too, key untouched",
      tts: {
        normalize: true,
        normalizeProvider: "anthropik",
        normalizeCredentialRef: "vault:9",
      },
      want: { runnable: false, reason: "provider_unknown", credential: "none" },
    },
    {
      // openai-compatible authenticates by its URL: a local llama.cpp-style server has no key at
      // all. Refusing it would leave "invent a dummy vault entry" as the only way in; running it on
      // the AGENT's key would ship an OpenAI secret to that local endpoint.
      name: "an openai-compatible endpoint with no key runs with NO key at all",
      tts: {
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeBaseURL: "http://llama:8080/v1",
      },
      want: {
        provider: "openai-compatible",
        baseURL: "http://llama:8080/v1",
        runnable: true,
        credential: "none",
      },
    },
    {
      name: "an openai-compatible endpoint with no URL anywhere is refused, not built",
      tts: { normalize: true, normalizeProvider: "openai-compatible" },
      want: { runnable: false, reason: "endpoint_missing" },
    },
    {
      // Inheriting from an openai-compatible AGENT: the endpoint comes with the provider, so this is
      // the ordinary same-vendor case and not an endpoint_missing.
      name: "an openai-compatible agent lends its endpoint to the unchanged provider",
      tts: { normalize: true, normalizeProvider: "openai-compatible" },
      agent: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "http://llama:8080/v1",
      },
      want: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "http://llama:8080/v1",
        credential: "agent",
      },
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
    {
      // A baseUrl stored ON the credential outranks the typed field, the same as everywhere else in
      // the tree.
      name: "the credential's own endpoint wins over the typed one",
      tts: {
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeCredentialRef: "vault:9",
        normalizeBaseURL: "http://typed:8080/v1",
      },
      ownCredentialBaseURL: "https://from-credential.example.com/v1",
      want: {
        baseURL: "https://from-credential.example.com/v1",
        credential: "own",
      },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        resolve(c.tts, c.agent ?? AGENT, c.ownCredentialBaseURL ?? null),
      ).toMatchObject(c.want);
    });
  }

  // Blank strings are what an editor field the operator cleared actually stores. They must read as
  // "unset", not as an empty model name going on the wire (the #94 failure).
  test("blank overrides read as unset, not as an empty model", () => {
    expect(
      resolve({ normalize: true, normalizeProvider: "  ", normalizeModel: "" }),
    ).toMatchObject({ provider: "openai", model: "gpt-5", baseURL: null });
  });

  // The editor passes a stricter endpoint check so a half-typed URL is refused before the save
  // rather than at the first audio reply. Same rule, two strictnesses, one implementation.
  test("a caller-supplied endpoint check is what decides `usable`", () => {
    const tts = readTtsConfig({
      tts: {
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeBaseURL: "llama:8080",
      },
    });
    expect(resolveNormalizeModel(tts, AGENT).runnable).toBe(true);
    expect(
      resolveNormalizeModel(tts, AGENT, {
        isUsableBaseURL: (raw) => /^https?:\/\//.test(raw),
      }),
    ).toMatchObject({ runnable: false, reason: "endpoint_missing" });
  });
});
