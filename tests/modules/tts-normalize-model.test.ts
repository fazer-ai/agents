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
// somewhere it was not issued for, or a model id asked of a vendor that never heard of it. Six
// separate review rounds found six different paths into it, every one the same shape: half of the
// pair stored beside the override, the other half read off a field the operator edits elsewhere.

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
      // The common case the feature exists for: same account, cheaper model. It names the vendor the
      // model was picked from, which is one extra field over REST and no extra action in the editor
      // (the picker fills it in), and it is what keeps the pair from coming apart later.
      name: "a model on the agent's own provider keeps the agent's key",
      tts: {
        normalize: true,
        normalizeProvider: "openai",
        normalizeModel: "gpt-4o-mini",
      },
      want: { provider: "openai", model: "gpt-4o-mini", credential: "agent" },
    },
    {
      // The same field with the vendor left unsaid. Nothing records WHICH provider that id was
      // picked from, so the next change to the agent's provider asks OpenAI's model id of Anthropic
      // and every rewrite fails silently back to raw speech. Refusing turns a silent failure into a
      // config-health issue the operator can see.
      name: "a model with the provider inherited is refused, not pinned by luck",
      tts: { normalize: true, normalizeModel: "gpt-4o-mini" },
      want: { runnable: false, reason: "override_without_provider" },
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
        reason: "credential_required",
        credential: "none",
      },
    },
    {
      // The same vendor but a DIFFERENT host. The agent's key was issued for the agent's endpoint,
      // not for this one, so reusing it would be the same leak with a smaller radius. Reachable from
      // the editor, which shows the endpoint field while leaving the key optional.
      name: "an endpoint override on the agent's own provider does not reuse the agent's key",
      tts: {
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeBaseURL: "https://unrelated-host.example.com/v1",
      },
      agent: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "http://llama:8080/v1",
      },
      want: {
        provider: "openai-compatible",
        baseURL: "https://unrelated-host.example.com/v1",
        runnable: true,
        // Nothing secret travels: the endpoint IS the credential here.
        credential: "none",
      },
    },
    {
      // The agent's endpoint spelled another way is the agent's endpoint: a trailing slash, an
      // upper-case host and a default port are what a URL parser discards, not another host. The
      // agent's key stays reusable, because it IS the same destination.
      name: "the agent's endpoint spelled another way is still the agent's destination",
      tts: {
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeBaseURL: "HTTP://LLAMA:8080/v1/",
      },
      agent: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "http://llama:8080/v1",
      },
      want: {
        provider: "openai-compatible",
        runnable: true,
        credential: "agent",
      },
    },
    {
      // But another PATH on the same host is another destination: a gateway can key its paths, and
      // this is the rule's own "leak with a smaller radius". Canonical, not origin-only.
      name: "another path on the same host is not the agent's destination",
      tts: {
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeBaseURL: "http://llama:8080/tenant-b/v1",
      },
      agent: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "http://llama:8080/v1",
      },
      want: {
        provider: "openai-compatible",
        runnable: true,
        credential: "none",
      },
    },
    {
      // Same, on a provider that cannot authenticate by URL: refused outright rather than run on a
      // key that does not belong to that host.
      // On OpenAI the endpoint is not merely unauthorized, it is INERT: the adapter drops it and the
      // call leaves for api.openai.com. Naming the missing key first would send the operator to buy
      // one that still would not reach the host they typed.
      name: "an endpoint override on a provider that cannot send one is refused as unsupported",
      tts: {
        normalize: true,
        normalizeBaseURL: "https://unrelated-host.example.com/v1",
      },
      want: { runnable: false, reason: "endpoint_unsupported" },
    },
    {
      // Naming the credential AND the provider it belongs to is how that intent is made explicit —
      // on a provider that can carry the endpoint at all.
      name: "an endpoint override WITH a named credential and provider is allowed",
      tts: {
        normalize: true,
        normalizeProvider: "openrouter",
        normalizeBaseURL: "https://proxy.example.com/v1",
        normalizeCredentialRef: "vault:1",
      },
      want: {
        baseURL: "https://proxy.example.com/v1",
        runnable: true,
        credential: "own",
      },
    },
    {
      // The same intent aimed at an adapter that has nowhere to put it. Running would send the key
      // AND the customer's text to the vendor's public endpoint — the exact opposite of what asking
      // for a proxy meant — so the configuration is refused instead of silently rerouted.
      name: "a proxy on a provider whose adapter drops it is refused, not quietly bypassed",
      tts: {
        normalize: true,
        normalizeProvider: "openai",
        normalizeBaseURL: "https://proxy.example.com/v1",
        normalizeCredentialRef: "vault:1",
      },
      want: { runnable: false, reason: "endpoint_unsupported" },
    },
    {
      // An endpoint the AGENT carries is a different matter: honored or dropped, the rewrite lands
      // exactly where the agent's own model lands, which is all this resolution ever promised.
      // Refusing here would take the rewrite away from every install whose agent has one.
      name: "an endpoint inherited from the agent is never judged, only an own one",
      tts: { normalize: true },
      agent: { ...AGENT, baseURL: "https://gw.example.com/v1" },
      want: {
        provider: "openai",
        baseURL: "https://gw.example.com/v1",
        runnable: true,
        credential: "agent",
      },
    },
    {
      // A dedicated key with the provider left inherited: nothing records WHICH vendor that key was
      // chosen for, so the next change to the agent's provider silently re-points it at one that
      // never issued it. And that change does not need REST — the General tab saves on its own,
      // without the Behavior tab's cleared state ever reaching the database.
      name: "a dedicated credential with the provider inherited is refused too",
      tts: {
        normalize: true,
        normalizeCredentialRef: "vault:9",
      },
      want: {
        runnable: false,
        reason: "override_without_provider",
        credential: "none",
      },
    },
    {
      // Naming the agent's OWN provider is the fix, and it costs the operator one field: from then
      // on the pair travels together in the settings bag and survives any change to the agent's.
      name: "the same credential, with the agent's provider named, is allowed",
      tts: {
        normalize: true,
        normalizeProvider: "openai",
        normalizeCredentialRef: "vault:9",
      },
      want: { provider: "openai", runnable: true, credential: "own" },
    },
    {
      // The other half of the same pinning problem. Naming the vendor pins WHO issued the key; it
      // says nothing about WHERE it may be sent, and the agent's endpoint is a field on another tab.
      // Inheriting it here would hand that key to whatever host the agent points at tomorrow, so a
      // dedicated key gets the vendor's own endpoint (null) unless it brings one.
      name: "a dedicated key does not inherit the agent's endpoint on the same vendor",
      tts: {
        normalize: true,
        normalizeProvider: "openai",
        normalizeCredentialRef: "vault:9",
      },
      agent: { ...AGENT, baseURL: "https://gw.example.com/v1" },
      want: {
        provider: "openai",
        baseURL: null,
        runnable: true,
        credential: "own",
      },
    },
    {
      // Same rule where the endpoint IS the address: with nothing of its own, there is no address to
      // send the key to, and borrowing the agent's is the leak above. Refused instead of guessed —
      // and the editor renders that field, so this is one keystroke from the operator.
      name: "a dedicated key on openai-compatible needs an endpoint of its own",
      tts: {
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeCredentialRef: "vault:9",
      },
      agent: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "http://llama:8080/v1",
      },
      want: { runnable: false, reason: "endpoint_unusable" },
    },
    {
      // And once it brings one, the pair is complete: vendor, host and key all stored together, so
      // nothing the agent does afterwards moves any of them.
      name: "a dedicated key with its own endpoint pins both halves of the destination",
      tts: {
        normalize: true,
        normalizeProvider: "openai-compatible",
        normalizeCredentialRef: "vault:9",
        normalizeBaseURL: "http://rewriter:8080/v1",
      },
      agent: {
        provider: "openai-compatible",
        model: "llama-3.1",
        baseURL: "http://llama:8080/v1",
      },
      want: {
        provider: "openai-compatible",
        baseURL: "http://rewriter:8080/v1",
        runnable: true,
        credential: "own",
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
      },
      want: {
        provider: "google",
        model: "gemini-2.5-flash",
        baseURL: null,
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
      want: { runnable: false, reason: "endpoint_unusable" },
    },
    {
      // Inheriting from an openai-compatible AGENT: the endpoint comes with the provider, so this is
      // the ordinary same-vendor case and not an endpoint_unusable.
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
      tts: {
        normalize: true,
        normalizeProvider: "openai",
        normalizeModel: "gpt-4o-mini",
      },
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
    ).toMatchObject({ runnable: false, reason: "endpoint_unusable" });
  });

  // And that check governs every provider that carries an endpoint, not only the one that REQUIRES
  // it. openrouter takes a base URL, so a malformed one is storable, and the strict reading is the
  // editor's: judged nowhere else, the save goes through and every rewrite dies on the wire.
  test("an undialable endpoint is refused on any provider that carries one", () => {
    const tts = readTtsConfig({
      tts: {
        normalize: true,
        normalizeProvider: "openrouter",
        normalizeCredentialRef: "vault:9",
        normalizeBaseURL: "llama:8080",
      },
    });
    expect(
      resolveNormalizeModel(tts, AGENT, {
        isUsableBaseURL: (raw) => /^https?:\/\//.test(raw),
      }),
    ).toMatchObject({ runnable: false, reason: "endpoint_unusable" });
    // The same configuration with a dialable one runs, so the refusal is about the URL and not
    // about openrouter having brought its own endpoint at all.
    expect(
      resolveNormalizeModel(
        readTtsConfig({
          tts: {
            normalize: true,
            normalizeProvider: "openrouter",
            normalizeCredentialRef: "vault:9",
            normalizeBaseURL: "https://openrouter.example.com/api/v1",
          },
        }),
        AGENT,
        { isUsableBaseURL: (raw) => /^https?:\/\//.test(raw) },
      ),
    ).toMatchObject({ runnable: true, credential: "own" });
  });

  // An endpoint the rewrite INHERITED is not judged by that check, on a provider that does not
  // require one: the rewrite lands wherever the agent's own model lands, which is the invariant the
  // whole resolution exists to keep. Judging it would take the rewrite away from every install
  // whose agent carries a URL its provider never dials.
  test("an inherited endpoint is not judged on a provider that does not require one", () => {
    expect(
      resolveNormalizeModel(
        readTtsConfig({ tts: { normalize: true, normalizeProvider: null } }),
        { provider: "openrouter", model: "x/y", baseURL: "llama:8080" },
        { isUsableBaseURL: (raw) => /^https?:\/\//.test(raw) },
      ),
    ).toMatchObject({ runnable: true, credential: "agent" });
  });
});
