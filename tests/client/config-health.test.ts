import { describe, expect, test } from "bun:test";
import { computeConfigIssues, issueHasAction } from "@/client/lib/configHealth";

// Phase E: detect features turned on without the credential they need (the import that strips
// secrets is the common trigger), each carrying a deep-link target (tab + section anchor).
const base = {
  // The agent's saved on/off. Only the out-of-hours collision reads it (see the interface), and this
  // fixture is the enabled case; the rows that turn it off say so.
  agentEnabled: true,
  modelProvider: "openai",
  modelCredentialRef: "vault:1",
  // What the rewrite inherits is the STORED model, which is a different input from the one above
  // (the General tab's pending edit). They agree in most rows; the ones that separate them say so.
  savedModelProvider: "openai",
  sttEnabled: false,
  sttCredentialRef: "",
  ttsMode: "never",
  ttsCredentialRef: "",
  visionEnabled: false,
  visionCredentialRef: "",
};

describe("computeConfigIssues", () => {
  test("a fully-credentialed agent has no issues", () => {
    expect(computeConfigIssues(base)).toEqual([]);
  });

  test("flags a model with no credential, deep-linking to general/general-model", () => {
    const issues = computeConfigIssues({ ...base, modelCredentialRef: "" });
    expect(issues).toEqual([
      { key: "model", tab: "general", sectionId: "general-model" },
    ]);
  });

  test("does NOT flag an openai-compatible model without a credential (base URL auth)", () => {
    const issues = computeConfigIssues({
      ...base,
      modelProvider: "openai-compatible",
      modelCredentialRef: "",
    });
    expect(issues).toEqual([]);
  });

  test("flags STT/TTS/vision enabled without a credential, each to its behavior section", () => {
    const issues = computeConfigIssues({
      ...base,
      sttEnabled: true,
      ttsMode: "mirror",
      visionEnabled: true,
    });
    expect(issues.map((i) => i.key).sort()).toEqual(["stt", "tts", "vision"]);
    expect(issues.every((i) => i.tab === "behavior")).toBe(true);
    expect(issues.find((i) => i.key === "tts")?.sectionId).toBe("tts");
  });

  test("does NOT flag an enabled feature that already has a credential", () => {
    const issues = computeConfigIssues({
      ...base,
      sttEnabled: true,
      sttCredentialRef: "vault:9",
      ttsMode: "mirror",
      ttsCredentialRef: "vault:8",
    });
    expect(issues).toEqual([]);
  });

  test("flags a referenced-but-pending model credential as pending, with its vaultId", () => {
    const issues = computeConfigIssues({
      ...base,
      pendingRefs: new Set(["vault:1"]),
    });
    expect(issues).toEqual([
      {
        key: "model",
        tab: "general",
        sectionId: "general-model",
        pending: true,
        vaultId: "1",
      },
    ]);
  });

  test("flags an enabled feature wired to a pending credential (stt/tts)", () => {
    const issues = computeConfigIssues({
      ...base,
      sttEnabled: true,
      sttCredentialRef: "vault:9",
      ttsMode: "mirror",
      ttsCredentialRef: "vault:8",
      pendingRefs: new Set(["vault:8", "vault:9"]),
    });
    const stt = issues.find((i) => i.key === "stt");
    const tts = issues.find((i) => i.key === "tts");
    expect(stt).toMatchObject({ pending: true, vaultId: "9" });
    expect(tts).toMatchObject({ pending: true, vaultId: "8" });
  });

  test("a filled credential not in pendingRefs is not flagged", () => {
    const issues = computeConfigIssues({
      ...base,
      pendingRefs: new Set(["vault:999"]),
    });
    expect(issues).toEqual([]);
  });
});

describe("computeConfigIssues — knowledge indexing gated by embedding", () => {
  const needsIndex = { knowledgeBasesNeedingIndex: [{ id: "5", name: "FAQ" }] };

  test("no embedding issue when no base needs indexing", () => {
    const issues = computeConfigIssues({ ...base, embeddingCredentialRef: "" });
    expect(issues).toEqual([]);
  });

  test("a base needing index with embedding UNCONFIGURED raises one embedding issue", () => {
    const issues = computeConfigIssues({
      ...base,
      ...needsIndex,
      embeddingCredentialRef: "",
    });
    expect(issues).toEqual([{ key: "embedding" }]);
  });

  test("a base needing index with a PENDING embedding credential raises a pending embedding issue", () => {
    const issues = computeConfigIssues({
      ...base,
      ...needsIndex,
      embeddingCredentialRef: "vault:7",
      pendingRefs: new Set(["vault:7"]),
    });
    expect(issues).toEqual([{ key: "embedding", pending: true, vaultId: "7" }]);
  });

  test("a base needing index with USABLE embedding raises the per-base knowledge issue, not embedding", () => {
    const issues = computeConfigIssues({
      ...base,
      ...needsIndex,
      embeddingCredentialRef: "vault:7",
    });
    expect(issues).toEqual([
      { key: "knowledge", knowledgeBaseId: "5", knowledgeBaseName: "FAQ" },
    ]);
  });
});

describe("computeConfigIssues — redirect enabled but incomplete", () => {
  test("no issue when redirect is off (even with no inboxes)", () => {
    expect(
      computeConfigIssues({
        ...base,
        redirectEnabled: false,
        redirectEntryInboxId: "",
        redirectWidgetInboxId: null,
      }),
    ).toEqual([]);
  });

  test("no issue when redirect is on and both inboxes are set", () => {
    expect(
      computeConfigIssues({
        ...base,
        redirectEnabled: true,
        redirectEntryInboxId: "30",
        redirectWidgetInboxId: 1,
      }),
    ).toEqual([]);
  });

  test("flags redirect on with a missing entry inbox, deep-linking to the Redirect tab", () => {
    expect(
      computeConfigIssues({
        ...base,
        redirectEnabled: true,
        redirectEntryInboxId: "",
        redirectWidgetInboxId: 1,
      }),
    ).toEqual([
      { key: "redirect", tab: "channelRedirect", sectionId: "cr-entry" },
    ]);
  });

  test("flags redirect on with a missing widget inbox", () => {
    const issues = computeConfigIssues({
      ...base,
      redirectEnabled: true,
      redirectEntryInboxId: "30",
      redirectWidgetInboxId: null,
    });
    expect(issues).toEqual([
      { key: "redirect", tab: "channelRedirect", sectionId: "cr-entry" },
    ]);
  });

  // The attendance summariser's own model. Its failure is louder than the rewrite's (the job fails
  // and retries to DEAD) and more expensive: what is lost is not one reply's delivery but the
  // contact's memory of an attendance that already ended, and nothing ever goes back for it. The
  // console is still the only place an operator would see it before it happens.
  describe("attendance summary model", () => {
    const mem = (compaction: Record<string, unknown>) => ({
      ...base,
      settings: { memory: { compaction: { enabled: true, ...compaction } } },
    });

    // Nothing configured IS the agent's model, and an agent model that cannot run is the "model"
    // issue. A second line for it would send the operator to fix the summariser when what is broken
    // is the agent.
    test("no override configured raises nothing", () => {
      expect(computeConfigIssues(mem({}))).toEqual([]);
      expect(computeConfigIssues({ ...base, settings: {} })).toEqual([]);
    });

    test("the agent's own provider, picked explicitly, needs no credential of its own", () => {
      expect(computeConfigIssues(mem({ provider: "openai" }))).toEqual([]);
    });

    test("a different provider with no key of its own is flagged", () => {
      expect(computeConfigIssues(mem({ provider: "anthropic" }))).toEqual([
        { key: "memoryModel", tab: "behavior", sectionId: "memory" },
      ]);
    });

    test("a different provider WITH its own key is fine", () => {
      expect(
        computeConfigIssues(
          mem({ provider: "anthropic", credentialRef: "vault:3" }),
        ),
      ).toEqual([]);
    });

    // The reason this check exists at all: REST and MCP write the bag directly, so a model id or a
    // key with no provider arrives here from paths the editor never validated, and the runtime
    // stores it without complaint and then never summarises.
    test("a model with no provider is flagged, not silently inherited", () => {
      expect(computeConfigIssues(mem({ model: "gpt-5.4-nano" }))).toEqual([
        { key: "memoryModel", tab: "behavior", sectionId: "memory" },
      ]);
    });

    // The editor's strictness, not the runtime's: `llama:8080` is a non-empty string, so the runtime
    // says "there is something there" and the summariser dies at the first closed attendance.
    test("an openai-compatible endpoint that is not a URL is flagged", () => {
      expect(
        computeConfigIssues(
          mem({ provider: "openai-compatible", baseURL: "llama:8080" }),
        ),
      ).toEqual([{ key: "memoryModel", tab: "behavior", sectionId: "memory" }]);
    });

    test("an openai-compatible endpoint with no address at all is flagged", () => {
      expect(
        computeConfigIssues(mem({ provider: "openai-compatible" })),
      ).toEqual([{ key: "memoryModel", tab: "behavior", sectionId: "memory" }]);
    });

    // Compaction off means there is no call to configure, so a leftover override is not a problem
    // the operator has to act on now.
    test("compaction turned off raises nothing, whatever the override holds", () => {
      expect(
        computeConfigIssues({
          ...base,
          settings: {
            memory: { compaction: { enabled: false, provider: "anthropic" } },
          },
        }),
      ).toEqual([]);
    });

    // The endpoint the runtime will actually use comes off the CREDENTIAL when it carries one
    // (`loadAgentConfig` reads it from the vault), and it outranks whatever the bag holds. A check
    // that resolves without it calls a summariser that runs perfectly well broken, the moment the
    // vault answers. Found by review, on the fix for the previous round.
    test("an endpoint carried by the credential is not reported as missing", () => {
      expect(
        computeConfigIssues({
          ...mem({ provider: "openai-compatible", credentialRef: "vault:3" }),
          savedMemoryCredentialBaseURL: "https://llm.internal.example/v1",
          knownRefs: new Set(["vault:1", "vault:3"]),
        }),
      ).toEqual([]);
    });

    // And the inverse the same omission hid: a credential that carries an endpoint on a vendor that
    // never sends one. The request would go to that vendor's own host, not the operator's.
    test("a credential endpoint on a keyed vendor is flagged as unsupported", () => {
      expect(
        computeConfigIssues({
          ...mem({ provider: "anthropic", credentialRef: "vault:3" }),
          savedMemoryCredentialBaseURL: "https://proxy.example/v1",
          knownRefs: new Set(["vault:1", "vault:3"]),
        }),
      ).toEqual([{ key: "memoryModel", tab: "behavior", sectionId: "memory" }]);
    });

    // Before the vault answers, an endpoint that is merely unread looks absent. Announcing a
    // runnable summariser as broken is the false alarm the deferral exists to prevent.
    test("no verdict while the vault has not answered about its credential", () => {
      expect(
        computeConfigIssues({
          ...mem({ provider: "openai-compatible", credentialRef: "vault:3" }),
          knownRefs: null,
        }),
      ).toEqual([]);
    });

    // The summariser shares that rule, and shared it with the same defect: this row is what the
    // extraction changed here. A summariser switched to another vendor with no address is
    // unrunnable whatever the vault later says about the AGENT's key.
    test("a SWITCHED provider with no address is reported even while the vault is silent", () => {
      expect(
        computeConfigIssues({
          ...mem({ provider: "openai-compatible", model: "llama" }),
          savedModelProvider: "openai",
          savedModelCredentialRef: "vault:1",
          knownRefs: null,
        }),
      ).toEqual([{ key: "memoryModel", tab: "behavior", sectionId: "memory" }]);
    });

    // And the case the wait exists for is untouched: an override on the agent's OWN provider does
    // inherit its endpoint, so a credential the vault has not read yet can still supply one.
    test("an override on the agent's own provider still waits for its credential", () => {
      expect(
        computeConfigIssues({
          ...mem({ provider: "openai-compatible", model: "llama" }),
          savedModelProvider: "openai-compatible",
          savedModelCredentialRef: "vault:1",
          knownRefs: null,
        }),
      ).toEqual([]);
    });

    test("its credential being a pending vault entry is flagged as pending", () => {
      expect(
        computeConfigIssues({
          ...mem({ provider: "openai", credentialRef: "vault:3" }),
          pendingRefs: new Set(["vault:3"]),
        }),
      ).toEqual([
        {
          key: "memoryModel",
          tab: "behavior",
          sectionId: "memory",
          pending: true,
          vaultId: "3",
        },
      ]);
    });
  });

  // The fallback provider is the one override whose whole purpose is to work on the day the primary
  // does not, so a fallback that cannot be built is worth less than none: it looks configured and it
  // is asked for exactly when nobody is watching a console. Review found it absent from here after
  // the runtime half was already written and tested (#143, round 4).
  describe("fallback provider", () => {
    const fb = (over: Record<string, unknown>) => ({
      ...base,
      settings: { modelFallback: over },
    });
    const ISSUE = {
      key: "modelFallback",
      tab: "behavior",
      sectionId: "modelFallback",
    } as const;

    // No `enabled` flag, unlike the summariser: a fallback exists exactly when both halves are
    // named. Half of one is refused at the write boundary, so what reaches here is either a whole
    // fallback or none, and none is not a configuration that can fail.
    test("no fallback configured raises nothing", () => {
      expect(computeConfigIssues(fb({}))).toEqual([]);
      expect(computeConfigIssues({ ...base, settings: {} })).toEqual([]);
    });

    test("the agent's own provider, picked explicitly, needs no credential of its own", () => {
      expect(
        computeConfigIssues(fb({ provider: "openai", model: "gpt-5.4-mini" })),
      ).toEqual([]);
    });

    test("a different provider with no key of its own is flagged", () => {
      expect(
        computeConfigIssues(fb({ provider: "anthropic", model: "claude" })),
      ).toEqual([ISSUE]);
    });

    test("a different provider WITH its own key is fine", () => {
      expect(
        computeConfigIssues(
          fb({
            provider: "anthropic",
            model: "claude",
            credentialRef: "vault:3",
          }),
        ),
      ).toEqual([]);
    });

    test("an openai-compatible endpoint that is not a URL is flagged", () => {
      expect(
        computeConfigIssues(
          fb({
            provider: "openai-compatible",
            model: "llama",
            baseURL: "llama:8080",
          }),
        ),
      ).toEqual([ISSUE]);
    });

    test("an openai-compatible endpoint with no address at all is flagged", () => {
      expect(
        computeConfigIssues(
          fb({ provider: "openai-compatible", model: "llama" }),
        ),
      ).toEqual([ISSUE]);
    });

    // The model is optional there and the ENDPOINT is not, so the two have to be judged apart: a
    // fallback naming that provider and nothing else is a fallback (`hasModelFallback` says so) and
    // still cannot run, which is exactly the state this panel exists to name.
    test("that provider with no model and no address is a configured, broken fallback", () => {
      expect(
        computeConfigIssues(fb({ provider: "openai-compatible" })),
      ).toEqual([ISSUE]);
    });

    test("and with an address it runs, model or no model", () => {
      expect(
        computeConfigIssues(
          fb({
            provider: "openai-compatible",
            baseURL: "https://llama.internal/v1",
          }),
        ),
      ).toEqual([]);
    });

    // The endpoint the runtime uses comes off the CREDENTIAL when it carries one, and it outranks
    // the bag. Same rule as the summariser's, and the same false alarm without it.
    test("an endpoint carried by the credential is not reported as missing", () => {
      expect(
        computeConfigIssues({
          ...fb({
            provider: "openai-compatible",
            model: "llama",
            credentialRef: "vault:3",
          }),
          savedModelFallbackCredentialBaseURL:
            "https://llm.internal.example/v1",
          knownRefs: new Set(["vault:1", "vault:3"]),
        }),
      ).toEqual([]);
    });

    test("no verdict while the vault has not answered about its credential", () => {
      expect(
        computeConfigIssues({
          ...fb({
            provider: "openai-compatible",
            model: "llama",
            credentialRef: "vault:3",
          }),
          knownRefs: null,
        }),
      ).toEqual([]);
    });

    // ...but the wait is about a credential that could CARRY that endpoint, and the agent's cannot
    // once the override names a different vendor. Written as "either credential is unread", this
    // reported nothing at all for a fallback that is definitely unrunnable, for as long as the vault
    // was unavailable. The same three lines guarded the speech rewrite and the summariser, so the
    // rule is one function now and the two rows below are the two halves of it.
    test("a SWITCHED provider with no address is reported even while the vault is silent", () => {
      expect(
        computeConfigIssues({
          ...fb({ provider: "openai-compatible", model: "llama" }),
          savedModelProvider: "openai",
          savedModelCredentialRef: "vault:1",
          knownRefs: null,
        }),
      ).toEqual([ISSUE]);
    });

    test("and one that inherits the agent's provider still waits for it", () => {
      expect(
        computeConfigIssues({
          ...fb({ provider: "openai-compatible", model: "llama" }),
          savedModelProvider: "openai-compatible",
          savedModelCredentialRef: "vault:1",
          knownRefs: null,
        }),
      ).toEqual([]);
    });

    // THE ROW THE FINDING WAS ABOUT. An import strips secrets, so the ref comes back pending and the
    // panel has to offer the fill action; without an entry here the screen shows a configured
    // fallback and no warning at all.
    test("its credential being a pending vault entry is flagged as pending", () => {
      expect(
        computeConfigIssues({
          ...fb({
            provider: "openai",
            model: "gpt-5.4-mini",
            credentialRef: "vault:3",
          }),
          pendingRefs: new Set(["vault:3"]),
        }),
      ).toEqual([{ ...ISSUE, pending: true, vaultId: "3" }]);
    });

    // And the other half of the same omission: an entry deleted after the fact. No `vaultId` on this
    // one, unlike pending — there is no entry left to deep-link to, which is `credIssue`'s own rule.
    test("its credential having been deleted is flagged as unresolved", () => {
      const issues = computeConfigIssues({
        ...fb({
          provider: "openai",
          model: "gpt-5.4-mini",
          credentialRef: "vault:9",
        }),
        knownRefs: new Set(["vault:1"]),
      });
      expect(issues).toEqual([{ ...ISSUE, unresolved: true }]);
    });
  });

  // The speech rewrite fails SILENTLY when it cannot run (best-effort: the audio still goes out,
  // just unrewritten), so the editor is the only place this can be caught.
  describe("speech rewrite model", () => {
    const audio = { ...base, ttsMode: "mirror", ttsCredentialRef: "vault:2" };

    test("inheriting the agent's model needs no credential of its own", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "",
        }),
      ).toEqual([]);
    });

    test("the agent's own provider, picked explicitly, still needs no credential", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "openai",
        }),
      ).toEqual([]);
    });

    test("a different provider with no key of its own is flagged", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "anthropic",
        }),
      ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
    });

    test("a different provider WITH its own key is fine", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "anthropic",
          ttsNormalizeCredentialRef: "vault:3",
        }),
      ).toEqual([]);
    });

    test("its credential being a pending vault entry is flagged as pending", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "openai",
          ttsNormalizeCredentialRef: "vault:3",
          pendingRefs: new Set(["vault:3"]),
        }),
      ).toEqual([
        {
          key: "ttsNormalize",
          tab: "behavior",
          sectionId: "tts",
          pending: true,
          vaultId: "3",
        },
      ]);
    });

    // A credential that is referenced but never filled is a second, independent way for the rewrite
    // to go quiet, and it is checked whether or not the provider was also overridden.
    test("a pending credential is reported as pending, with its vaultId", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "openai",
          ttsNormalizeCredentialRef: "vault:3",
          pendingRefs: new Set(["vault:3"]),
        }),
      ).toEqual([
        {
          key: "ttsNormalize",
          tab: "behavior",
          sectionId: "tts",
          pending: true,
          vaultId: "3",
        },
      ]);
    });

    test("a resolvable credential with its provider named raises nothing", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "openai",
          ttsNormalizeCredentialRef: "vault:3",
        }),
      ).toEqual([]);
    });

    test("nothing is flagged while audio replies are off", () => {
      expect(
        computeConfigIssues({
          ...base,
          ttsNormalize: true,
          ttsNormalizeProvider: "anthropic",
        }),
      ).toEqual([]);
    });

    // A dedicated key with the provider left inherited cannot run: nothing records which vendor it
    // was chosen for. The editor cannot produce this (picking a key pins the provider), but REST and
    // MCP write the bag directly, and the runtime failure is silent.
    test("a credential stored without its provider is surfaced, not left silent", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "",
          ttsNormalizeCredentialRef: "vault:3",
        }),
      ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
    });

    // An openai-compatible endpoint authenticates by its URL: the resolver runs it with no key at
    // all, so a permanent "missing credential" warning here would be the editor contradicting the
    // runtime about a configuration that works.
    test("a keyless openai-compatible endpoint with a URL raises nothing", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "openai-compatible",
          ttsNormalizeBaseURL: "http://llama:8080/v1",
        }),
      ).toEqual([]);
    });

    // Same provider, no endpoint of its own: it inherits the agent's, so there is nothing to warn
    // about here either.
    test("an openai-compatible agent lending its endpoint raises nothing", () => {
      expect(
        computeConfigIssues({
          ...audio,
          savedModelProvider: "openai-compatible",
          savedModelBaseURL: "http://llama:8080/v1",
          ttsNormalize: true,
          ttsNormalizeProvider: "openai-compatible",
        }),
      ).toEqual([]);
    });

    // An endpoint no HTTP client can dial. Only REST and MCP can store one (the form refuses it
    // before the save), and at runtime it costs the rewrite on EVERY audio reply, silently — so this
    // screen judges endpoints the way the form does, not the way the runtime does.
    test("an endpoint that is not an http(s) URL is surfaced", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "openai-compatible",
          ttsNormalizeBaseURL: "llama:8080",
        }),
      ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
    });

    // And the same endpoint inherited from the agent, which is the shape an operator reaches by
    // typing it once on General: the rewrite dies there too, so it is flagged there too.
    test("an inherited endpoint that is not an http(s) URL is surfaced", () => {
      expect(
        computeConfigIssues({
          ...audio,
          savedModelProvider: "openai-compatible",
          savedModelBaseURL: "llama:8080",
          ttsNormalize: true,
          ttsNormalizeProvider: "openai-compatible",
        }),
      ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
    });

    // The tabs of the editor save independently, so what the rewrite inherits is the model that is
    // STORED, not the one the operator is part-way through changing on General. Judging against the
    // pending edit blesses a pairing that will not exist: the Behavior save carries the rewrite and
    // none of General, so the bag lands naming a vendor the saved agent never had.
    test("the rewrite is judged against the SAVED model, not the edited one", () => {
      const rewrite = {
        ...audio,
        ttsNormalize: true,
        ttsNormalizeProvider: "anthropic",
      };
      // Mid-edit on General: anthropic on screen, openai stored. The rewrite would ride a key the
      // stored agent does not have, so it needs one of its own.
      expect(
        computeConfigIssues({
          ...rewrite,
          modelProvider: "anthropic",
          savedModelProvider: "openai",
        }),
      ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
      // Once that edit is SAVED, the same rewrite inherits the agent's key and raises nothing.
      expect(
        computeConfigIssues({
          ...rewrite,
          modelProvider: "anthropic",
          savedModelProvider: "anthropic",
        }),
      ).toEqual([]);
    });

    // A provider name REST or MCP stored that we do not support. The editor cannot produce it and
    // the runtime skips it without a word, so this is the only screen that will ever mention it.
    // What the message must NOT do is name a missing credential, which would send the operator to
    // buy a key for a typo.
    test("an unsupported provider name is surfaced too", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "anthropik",
        }),
      ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
    });

    // The same shape as the credential above, one field over. A model id picked for the agent's old
    // vendor survives a provider change made on another tab (and a REST patch of modelConfig never
    // touches the settings bag at all), and the runtime failure is silent: the audio goes out
    // unrewritten forever.
    test("a model id stored without its provider is surfaced", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "",
          ttsNormalizeModel: "gpt-4o-mini",
        }),
      ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
    });

    // A dedicated key with nowhere to send it. The endpoint is not inherited from the agent once the
    // rewrite has a key of its own, so this bag is dead until someone gives it an address — and a
    // bag written over REST has no field validation to say so.
    test("a dedicated key with no endpoint of its own is surfaced", () => {
      expect(
        computeConfigIssues({
          ...audio,
          savedModelProvider: "openai-compatible",
          savedModelBaseURL: "http://llama:8080/v1",
          ttsNormalize: true,
          ttsNormalizeProvider: "openai-compatible",
          ttsNormalizeCredentialRef: "vault:3",
        }),
      ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
    });
  });
});

// A stored ref can point at a vault entry that no longer exists. Deleting an entry is not blocked by
// its references (the vault's delete is a plain deleteMany; the reference list it shows is
// informational), and `PATCH /v1/agents/:id` stores whatever ref it is handed, name or id. The
// runtime is where it lands: the agent's own model logs "cannot reply until it is fixed", and
// STT/vision/TTS/the speech rewrite skip with a warn line nobody is watching for. Which makes this
// panel the one place it can be caught before the next customer message, and it stayed green.
describe("computeConfigIssues — a credential whose vault entry is gone", () => {
  const linked = {
    key: "model",
    tab: "general",
    sectionId: "general-model",
  } as const;

  test("flags the model credential when the vault no longer holds it", () => {
    expect(
      computeConfigIssues({ ...base, knownRefs: new Set(["vault:7"]) }),
    ).toEqual([{ ...linked, unresolved: true }]);
  });

  // The vault list arrives one request after the first paint. An empty set would mean "no credential
  // resolves" and light up every field on screen for a moment, so "not loaded" has to be its own
  // value and it has to mean silence.
  test("raises nothing while the vault has not loaded (undefined or null)", () => {
    expect(computeConfigIssues(base)).toEqual([]);
    expect(computeConfigIssues({ ...base, knownRefs: null })).toEqual([]);
  });

  // Refs are resolved by id and only by id (`vaultRefWhere` matches `vault:<id>`; anything else falls
  // through to a never-matching row). A name reaches the field over MCP and REST, reads as configured
  // in the editor, and resolves to nothing at runtime — the same failure by another spelling.
  test("flags a ref stored as a name, which no resolver will ever match", () => {
    expect(
      computeConfigIssues({
        ...base,
        modelCredentialRef: "openai-key",
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([{ ...linked, unresolved: true }]);
  });

  // A pending entry EXISTS, so it is in the known set; the two states cannot both be true. Asserted
  // anyway because the fixes differ: pending opens the fill modal, unresolved sends the operator
  // back to the field to pick another key.
  test("a pending entry is reported as pending, never as unresolved", () => {
    expect(
      computeConfigIssues({
        ...base,
        pendingRefs: new Set(["vault:1"]),
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([{ ...linked, pending: true, vaultId: "1" }]);
  });

  test("flags stt, tts and vision the same way, each to its own section", () => {
    const issues = computeConfigIssues({
      ...base,
      sttEnabled: true,
      sttCredentialRef: "vault:9",
      ttsMode: "mirror",
      ttsCredentialRef: "vault:8",
      visionEnabled: true,
      visionCredentialRef: "vault:6",
      knownRefs: new Set(["vault:1"]),
    });
    expect(
      issues.map((i) => `${i.key}:${i.unresolved}:${i.sectionId}`),
    ).toEqual(["stt:true:stt", "tts:true:tts", "vision:true:vision"]);
  });

  test("flags the speech rewrite's own credential", () => {
    expect(
      computeConfigIssues({
        ...base,
        ttsMode: "mirror",
        ttsCredentialRef: "vault:2",
        ttsNormalize: true,
        ttsNormalizeProvider: "anthropic",
        ttsNormalizeCredentialRef: "vault:3",
        knownRefs: new Set(["vault:1", "vault:2"]),
      }),
    ).toEqual([
      {
        key: "ttsNormalize",
        tab: "behavior",
        sectionId: "tts",
        unresolved: true,
      },
    ]);
  });

  // The rewrite has a second, earlier way to be unusable: the resolver refusing the bag outright.
  // That verdict does not depend on the vault, and it is the one the operator has to act on first,
  // so it stays the single issue raised.
  test("a bag the resolver refuses stays one issue, not two", () => {
    expect(
      computeConfigIssues({
        ...base,
        ttsMode: "mirror",
        ttsCredentialRef: "vault:2",
        ttsNormalize: true,
        ttsNormalizeProvider: "not-a-provider",
        ttsNormalizeCredentialRef: "vault:3",
        knownRefs: new Set(["vault:1", "vault:2"]),
      }),
    ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
  });

  // The tenant's embedding key is the sixth ref that can dangle, and it fails the same way: the
  // per-base "index me" prompts would all fail on a key that is not there, so the root cause is the
  // one issue raised.
  test("flags the tenant embedding credential instead of the per-base index prompts", () => {
    expect(
      computeConfigIssues({
        ...base,
        knowledgeBasesNeedingIndex: [{ id: "5", name: "FAQ" }],
        embeddingCredentialRef: "vault:7",
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([{ key: "embedding", unresolved: true }]);
  });
});

// `vault:007` and `vault:7` are the same entry: the runtime parses the id with BigInt, so a
// noncanonical spelling resolves fine. It reaches the field the way every unvalidated ref does,
// through `PATCH /v1/agents/:id`, which stores what it is handed. Comparing raw strings against a
// list that only ever holds the canonical spelling would call a working credential deleted, which
// is a worse failure than the silence this whole change replaced.
describe("computeConfigIssues — noncanonical ref spellings", () => {
  test("a padded id resolves against the canonical list", () => {
    expect(
      computeConfigIssues({
        ...base,
        modelCredentialRef: "vault:0001",
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([]);
  });

  test("a padded id still reports pending, with the canonical vaultId", () => {
    expect(
      computeConfigIssues({
        ...base,
        modelCredentialRef: "vault:0001",
        knownRefs: new Set(["vault:1"]),
        pendingRefs: new Set(["vault:1"]),
      }),
    ).toEqual([
      {
        key: "model",
        tab: "general",
        sectionId: "general-model",
        pending: true,
        vaultId: "1",
      },
    ]);
  });

  test("a ref whose id is not a number is unresolvable, like a name", () => {
    expect(
      computeConfigIssues({
        ...base,
        modelCredentialRef: "vault:abc",
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([
      {
        key: "model",
        tab: "general",
        sectionId: "general-model",
        unresolved: true,
      },
    ]);
  });
});

// An OpenAI-compatible model authenticates through its base URL, so it needs no credential — which
// is a statement about a credential being ABSENT, and it was being read as "this field is never
// checked". A ref that IS set has to resolve whatever the provider is: `loadAgentConfig` resolves
// it before it looks at the provider, and returns null for the whole agent when it cannot, so the
// agent goes silent on every message.
describe("computeConfigIssues — an openai-compatible model with a ref of its own", () => {
  const compat = { ...base, modelProvider: "openai-compatible" };

  test("still raises nothing when no credential is set", () => {
    expect(
      computeConfigIssues({
        ...compat,
        modelCredentialRef: "",
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([]);
  });

  test("flags a credential it does set whose entry is gone", () => {
    expect(
      computeConfigIssues({ ...compat, knownRefs: new Set(["vault:9"]) }),
    ).toEqual([
      {
        key: "model",
        tab: "general",
        sectionId: "general-model",
        unresolved: true,
      },
    ]);
  });

  test("flags a credential it does set that is still pending", () => {
    expect(
      computeConfigIssues({
        ...compat,
        pendingRefs: new Set(["vault:1"]),
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([
      {
        key: "model",
        tab: "general",
        sectionId: "general-model",
        pending: true,
        vaultId: "1",
      },
    ]);
  });
});

// The seventh credential the agent can hold, and the only one whose failure lets messages through
// UNSCREENED: `loadAgentConfig` fails open when the guardrails credential does not resolve, so the
// analysis is skipped and every message is delivered as if it had been reviewed and approved.
describe("computeConfigIssues — the guardrails credential", () => {
  const guarded = { ...base, guardrailsEnabled: true };
  const at = { tab: "guardrails", sectionId: "gr-model" } as const;

  test("raises nothing while guardrails are off, whatever the ref says", () => {
    expect(
      computeConfigIssues({
        ...base,
        guardrailsEnabled: false,
        guardrailsCredentialRef: "vault:404",
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([]);
  });

  test("flags guardrails enabled with no credential", () => {
    expect(
      computeConfigIssues({ ...guarded, guardrailsCredentialRef: "" }),
    ).toEqual([{ key: "guardrails", ...at }]);
  });

  test("flags a pending guardrails credential", () => {
    expect(
      computeConfigIssues({
        ...guarded,
        guardrailsCredentialRef: "vault:5",
        pendingRefs: new Set(["vault:5"]),
        knownRefs: new Set(["vault:1", "vault:5"]),
      }),
    ).toEqual([{ key: "guardrails", ...at, pending: true, vaultId: "5" }]);
  });

  test("flags a guardrails credential whose entry is gone", () => {
    expect(
      computeConfigIssues({
        ...guarded,
        guardrailsCredentialRef: "vault:5",
        knownRefs: new Set(["vault:1"]),
      }),
    ).toEqual([{ key: "guardrails", ...at, unresolved: true }]);
  });
});

// The half of "unscreened" that configuration cannot see. A retired model id, a parameter the vendor
// rejects on every call (#130 was a live instance) and a chronic timeout are all valid configuration
// right up to the moment the call is made, and the analysis is fail-open, so every one of them
// delivers messages as if they had been reviewed. What the screen actually DID is read back from the
// execution log and handed to the panel as a count.
describe("computeConfigIssues — a guardrail that could not run", () => {
  const guarded = {
    ...base,
    guardrailsEnabled: true,
    guardrailsCredentialRef: "vault:1",
  };
  const at = { tab: "guardrails", sectionId: "gr-model" } as const;

  test("flags a credentialed guardrail whose analyses have been failing", () => {
    expect(
      computeConfigIssues({
        ...guarded,
        guardrailsFailures: 47,
        guardrailsLastFailureAt: "2026-08-19T12:00:00.000Z",
      }),
    ).toEqual([
      {
        key: "guardrailsFailing",
        ...at,
        failures: 47,
        lastFailureAt: "2026-08-19T12:00:00.000Z",
      },
    ]);
  });

  test("raises nothing when nothing failed in the window", () => {
    expect(computeConfigIssues({ ...guarded, guardrailsFailures: 0 })).toEqual(
      [],
    );
  });

  test("raises nothing while guardrails are off, whatever the log holds", () => {
    expect(
      computeConfigIssues({
        ...base,
        guardrailsEnabled: false,
        guardrailsCredentialRef: "vault:1",
        guardrailsFailures: 47,
      }),
    ).toEqual([]);
  });

  // One root cause, not two. With no credential the runtime never builds the model, so it writes no
  // failure rows at all: a count arriving alongside a credential issue can only be a leftover from
  // before the credential broke, and repeating the symptom under the cause trains the operator to
  // skim the panel.
  test("stays quiet while the credential issue is live", () => {
    expect(
      computeConfigIssues({
        ...guarded,
        guardrailsCredentialRef: "",
        guardrailsFailures: 47,
      }),
    ).toEqual([{ key: "guardrails", ...at }]);
  });

  test("survives a count with no timestamp", () => {
    expect(computeConfigIssues({ ...guarded, guardrailsFailures: 3 })).toEqual([
      { key: "guardrailsFailing", ...at, failures: 3 },
    ]);
  });
});

// Found by sweeping the panel's own inputs rather than by a review round: the rewrite's endpoint can
// live on its CREDENTIAL, and the browser learns credential endpoints from the same vault list that
// arrives a request after the first paint. Judged before that answer exists, an endpoint that is
// merely unread reads as absent, and the panel announces that a runnable rewrite cannot run — the
// same false alarm the null-until-loaded rule exists to prevent, arriving through the endpoint
// instead of through the ref.
describe("computeConfigIssues — the rewrite endpoint while the vault is unknown", () => {
  const compatRewrite = {
    ...base,
    ttsMode: "mirror",
    ttsCredentialRef: "vault:2",
    ttsNormalize: true,
    ttsNormalizeProvider: "openai-compatible",
    ttsNormalizeCredentialRef: "vault:3",
    ttsNormalizeBaseURL: "",
  };

  test("holds the endpoint refusal while the vault has not answered", () => {
    expect(computeConfigIssues({ ...compatRewrite, knownRefs: null })).toEqual(
      [],
    );
  });

  test("raises it once the vault has answered and the endpoint is still nowhere", () => {
    expect(
      computeConfigIssues({
        ...compatRewrite,
        knownRefs: new Set(["vault:1", "vault:2", "vault:3"]),
      }),
    ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
  });

  // Only the endpoint answer comes from the vault. A bag naming a provider that does not exist is
  // wrong on its face, and waiting on a list that cannot change that verdict would just delay it.
  test("still refuses a bag the vault could not rescue", () => {
    expect(
      computeConfigIssues({
        ...compatRewrite,
        ttsNormalizeProvider: "not-a-provider",
        knownRefs: null,
      }),
    ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
  });
});

// The endpoint refusal waits for the vault, but only where the vault could still change it. A
// failed vault load leaves that answer missing INDEFINITELY (nothing retries until a mutation or a
// reload), so deferring a verdict the vault cannot rescue would not delay a warning, it would
// delete one.
describe("computeConfigIssues — which endpoint refusals wait for the vault", () => {
  const audio = { ...base, ttsMode: "mirror", ttsCredentialRef: "vault:2" };

  test("an undialable endpoint with no credential to correct it is decided now", () => {
    expect(
      computeConfigIssues({
        ...audio,
        ttsNormalize: true,
        ttsNormalizeProvider: "openai-compatible",
        ttsNormalizeBaseURL: "llama:8080",
        knownRefs: null,
      }),
    ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
  });

  // A stated endpoint does not settle the question, because a credential's own base URL WINS over
  // the typed one, here and in the runtime alike — so an unread credential can still replace an
  // undialable string with a working host, and calling the rewrite dead before reading it would be
  // wrong in the same way it was wrong with no endpoint at all.
  test("waits on an undialable endpoint that a credential could still replace", () => {
    expect(
      computeConfigIssues({
        ...audio,
        ttsNormalize: true,
        ttsNormalizeProvider: "openai-compatible",
        ttsNormalizeCredentialRef: "vault:3",
        ttsNormalizeBaseURL: "llama:8080",
        knownRefs: null,
      }),
    ).toEqual([]);
  });

  test("no endpoint and no credential anywhere is decided without the vault", () => {
    expect(
      computeConfigIssues({
        ...audio,
        savedModelProvider: "openai",
        ttsNormalize: true,
        ttsNormalizeProvider: "openai-compatible",
        ttsNormalizeBaseURL: "",
        knownRefs: null,
      }),
    ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
  });

  test("waits when the rewrite's own credential could carry the endpoint", () => {
    expect(
      computeConfigIssues({
        ...audio,
        ttsNormalize: true,
        ttsNormalizeProvider: "openai-compatible",
        ttsNormalizeCredentialRef: "vault:3",
        ttsNormalizeBaseURL: "",
        knownRefs: null,
      }),
    ).toEqual([]);
  });

  // Inheriting the agent's model means inheriting its endpoint, and the agent's endpoint can live on
  // the agent's credential — read from the same list.
  test("waits when the inherited agent credential could carry it", () => {
    expect(
      computeConfigIssues({
        ...audio,
        savedModelProvider: "openai-compatible",
        savedModelCredentialRef: "vault:1",
        savedModelBaseURL: "",
        ttsNormalize: true,
        ttsNormalizeProvider: "",
        ttsNormalizeBaseURL: "",
        knownRefs: null,
      }),
    ).toEqual([]);
  });

  test("stops waiting once the vault has answered and nothing supplied one", () => {
    expect(
      computeConfigIssues({
        ...audio,
        ttsNormalize: true,
        ttsNormalizeProvider: "openai-compatible",
        ttsNormalizeCredentialRef: "vault:3",
        ttsNormalizeBaseURL: "",
        knownRefs: new Set(["vault:1", "vault:2", "vault:3"]),
      }),
    ).toEqual([{ key: "ttsNormalize", tab: "behavior", sectionId: "tts" }]);
  });
});

// Text stored over its cap is cut on the way to the model and nowhere else, so the editor is the
// only place it can surface. It has to surface from OUTSIDE the field: the boundary deliberately
// lets an untouched legacy value save, and the field itself may not be on screen — several of these
// notes have no control in the editor at all, and the sections that do only render when switched on.
// Issue #166. The one check here that is not about a feature failing to run: both features run, and
// it is the customer who gets the wrong experience. The list of inboxes comes from the server (a live
// Chatwoot read), so everything below is about what the panel DOES with it.
describe("computeConfigIssues — Chatwoot already answers out of hours", () => {
  const ONE = [{ id: "5", name: "WhatsApp Vendas" }];
  // A schedule that actually closes. Without one the reactive gate never silences the agent, so its
  // away message never goes out however the block is configured — which is review round 1's finding.
  const CLOSES = {
    windows: [{ day: 1, start: "09:00", end: "17:00" }],
    exceptions: [],
    timezone: "UTC",
  };
  const AWAY_ON = {
    availability: { enabled: true, awayMessage: "Estamos fechados." },
  };

  test("no inboxes, or an empty list, raises nothing", () => {
    expect(computeConfigIssues(base)).toEqual([]);
    expect(computeConfigIssues({ ...base, outOfOfficeInboxes: [] })).toEqual(
      [],
    );
  });

  // With the agent silent out of hours, the customer is told the business is closed and then served
  // by a bot that reads a different calendar. Nothing about the agent's own message is needed for
  // that, which is why this fires with the availability block untouched.
  test("Chatwoot's alone → the contradiction, deep-linked to behavior/availability", () => {
    expect(computeConfigIssues({ ...base, outOfOfficeInboxes: ONE })).toEqual([
      {
        key: "outOfHoursChatwoot",
        tab: "behavior",
        sectionId: "availability",
        inboxNames: ["WhatsApp Vendas"],
      },
    ]);
  });

  test("both on → the duplicate, and the inboxes are named in order", () => {
    const issues = computeConfigIssues({
      ...base,
      settings: AWAY_ON,
      savedSchedule: CLOSES,
      outOfOfficeInboxes: [
        { id: "5", name: "WhatsApp Vendas" },
        { id: "9", name: "Instagram" },
      ],
    });
    expect(issues).toEqual([
      {
        key: "outOfHoursBoth",
        tab: "behavior",
        sectionId: "availability",
        inboxNames: ["WhatsApp Vendas", "Instagram"],
      },
    ]);
  });

  // The switch is what the operator flipped; the copy is what actually goes out. Either one missing
  // means the agent says nothing, so the collision is the contradiction and not the duplicate — and
  // a bag that spells the switch any other way is off (readAvailabilityConfig is strict on purpose).
  const SILENT: Array<[string, unknown]> = [
    ["switched off", { enabled: false, awayMessage: "Estamos fechados." }],
    ["no copy", { enabled: true, awayMessage: "" }],
    ["copy that is only whitespace", { enabled: true, awayMessage: "   " }],
    ["the switch as a string", { enabled: "true", awayMessage: "Fechados." }],
    ["no availability block at all", undefined],
  ];
  for (const [label, availability] of SILENT) {
    test(`an agent with ${label} gets the contradiction, not the duplicate`, () => {
      const issues = computeConfigIssues({
        ...base,
        settings: availability === undefined ? {} : { availability },
        // A schedule that closes, so this row isolates the availability block: the only reason the
        // agent stays quiet is the block itself.
        savedSchedule: CLOSES,
        outOfOfficeInboxes: ONE,
      });
      expect(issues.map((i) => i.key)).toEqual(["outOfHoursChatwoot"]);
    });
  }

  // Review round 1. The away message rides the SAME gate that silences replies, so an agent that
  // never closes sends nothing out of hours with the switch on and the copy written. Claiming the
  // duplicate there describes two messages where the customer gets a closure notice and then normal
  // service — the contradiction, and the worse of the two.
  const NEVER_CLOSES: Array<[string, unknown]> = [
    ["no schedule at all (always on)", null],
    ["a schedule with no windows", { ...CLOSES, windows: [] }],
  ];
  for (const [label, savedSchedule] of NEVER_CLOSES) {
    test(`away copy on but ${label} → the contradiction`, () => {
      const issues = computeConfigIssues({
        ...base,
        settings: AWAY_ON,
        savedSchedule: savedSchedule as never,
        outOfOfficeInboxes: ONE,
      });
      expect(issues.map((i) => i.key)).toEqual(["outOfHoursChatwoot"]);
    });
  }

  // The mirror of the pair above: the schedule alone does not make it the duplicate either.
  test("a closing schedule with the away message off is still the contradiction", () => {
    const issues = computeConfigIssues({
      ...base,
      settings: { availability: { enabled: false, awayMessage: "Fechados." } },
      savedSchedule: CLOSES,
      outOfOfficeInboxes: ONE,
    });
    expect(issues.map((i) => i.key)).toEqual(["outOfHoursChatwoot"]);
  });

  // Review round 2. A disabled agent says nothing to the customer at all — the runtime gates the away
  // message on it and refuses the turn a few lines later — so Chatwoot's message is the only one that
  // arrives and NEITHER spelling is true. This is the one line in this panel that claims something
  // about what the customer receives rather than about the configuration, which is why it is also the
  // only one that has to care.
  for (const [label, settings] of [
    ["with its away message on", AWAY_ON],
    ["with nothing of its own to say", {}],
  ] as Array<[string, unknown]>) {
    test(`a disabled agent ${label} raises nothing`, () => {
      expect(
        computeConfigIssues({
          ...base,
          agentEnabled: false,
          settings,
          savedSchedule: CLOSES,
          outOfOfficeInboxes: ONE,
        }),
      ).toEqual([]);
    });
  }

  // Every other line in the panel offers a fix; these two must as well, or the operator reads a
  // problem with no way in.
  test("both spellings offer an action", () => {
    for (const settings of [
      {},
      { availability: { enabled: true, awayMessage: "x" } },
    ]) {
      const issue = computeConfigIssues({
        ...base,
        settings,
        savedSchedule: CLOSES,
        outOfOfficeInboxes: ONE,
      })[0];
      expect(issue && issueHasAction(issue)).toBe(true);
    }
  });
});

describe("computeConfigIssues — text stored over its cap", () => {
  const bag = (settings: Record<string, unknown>) => ({ ...base, settings });

  test("no settings, or nothing over its cap, is no issue", () => {
    expect(computeConfigIssues(base)).toEqual([]);
    expect(
      computeConfigIssues(bag({ handoff: { instructions: "short" } })),
    ).toEqual([]);
  });

  test("flags an over-cap tool note, deep-linking to the native tools section", () => {
    const issues = computeConfigIssues(
      bag({ handoff: { instructions: "h".repeat(1501) } }),
    );
    expect(issues).toEqual([
      {
        key: "textCap",
        tab: "tools",
        sectionId: "tools-native",
        field: "handoff.instructions",
        length: 1501,
        max: 1500,
      },
    ]);
  });

  test("each capped family deep-links to where its field actually lives", () => {
    // Guardrails ON, because its inner sections are only mounted then (the row below covers OFF).
    const target = (settings: Record<string, unknown>) => {
      const issue = computeConfigIssues({
        ...bag(settings),
        guardrailsEnabled: true,
        guardrailsCredentialRef: "vault:1",
      }).find((i) => i.key === "textCap");
      return `${issue?.tab ?? "-"}/${issue?.sectionId ?? "-"}`;
    };
    expect(target({ guardrails: { customPolicy: "p".repeat(2001) } })).toBe(
      "guardrails/gr-policy",
    );
    expect(
      target({ guardrails: { input: { templateMessage: "t".repeat(2001) } } }),
    ).toBe("guardrails/gr-input");
    expect(
      target({
        guardrails: { output: { generationPrompt: "g".repeat(2001) } },
      }),
    ).toBe("guardrails/gr-output");
    expect(target({ toolGuidance: { assign_label: "l".repeat(1501) } })).toBe(
      "tools/tools-native",
    );
    expect(target({ vision: { extractionPrompt: "v".repeat(4001) } })).toBe(
      "behavior/vision",
    );
    expect(
      target({ followUp: { steps: [{ instructions: "f".repeat(2001) }] } }),
    ).toBe("behavior/proactive");
  });

  // GuardrailsTab renders gr-input/gr-output/gr-policy only when guardrails are ON, so with them off
  // the deep-link would carry an anchor that is not in the DOM: the editor's one-shot lookup finds
  // nothing, and the operator lands on the tab with no scroll, no highlight and no field. gr-model is
  // the section that is always mounted, and it holds the switch that reveals the rest.
  test("with guardrails off, its warnings target the section that is actually mounted", () => {
    const off = computeConfigIssues(
      bag({ guardrails: { customPolicy: "p".repeat(2001) } }),
    ).find((i) => i.key === "textCap");
    expect(off?.sectionId).toBe("gr-model");

    const on = computeConfigIssues({
      ...bag({ guardrails: { customPolicy: "p".repeat(2001) } }),
      guardrailsEnabled: true,
      guardrailsCredentialRef: "vault:1",
    }).find((i) => i.key === "textCap");
    expect(on?.sectionId).toBe("gr-policy");
  });

  // The reported case: a note written through REST or MCP for a native tool the editor has no field
  // for. It still gets an issue — that is the only way the operator learns the text is being cut —
  // but with no deep-link target, because there is nowhere to send them.
  test("a note with no control in the editor is flagged without a target", () => {
    const [issue] = computeConfigIssues(
      bag({ toolGuidance: { private_note: "n".repeat(1501) } }),
    );
    expect(issue).toEqual({
      key: "textCap",
      field: "toolGuidance.private_note",
      length: 1501,
      max: 1500,
    });
  });

  test("every over-cap field gets its own row", () => {
    const issues = computeConfigIssues(
      bag({
        handoff: { instructions: "h".repeat(1501) },
        vision: { extractionPrompt: "v".repeat(4001) },
      }),
    );
    expect(issues.map((i) => i.field).sort()).toEqual([
      "handoff.instructions",
      "vision.extractionPrompt",
    ]);
  });
});

// The panel hides its button for a warning with nothing to click. That is only ever a textCap issue
// for a field the console has no control for: an embedding issue also carries no tab, and its fix
// (fill the vault entry, or set the tenant embedding) is exactly what the button is for.
describe("issueHasAction", () => {
  // The unlock flow needs the conversation to still be the bot's when the code arrives, and the
  // handoff gives it away on the first refusal. Neither switch is wrong alone, so the pair is
  // reported rather than resolved.
  describe("the unlock flow against the handoff", () => {
    const unlocking = {
      ...base,
      contactAuthEnabled: true,
      contactAuthUrl: "https://ops.example.com/authorize",
      contactAuthIncludeMessageText: true,
      contactAuthHandoffEnabled: true,
    };

    test("flags the pair, deep-linking to behavior/contactAuth", () => {
      expect(computeConfigIssues(unlocking)).toEqual([
        {
          key: "contactAuthUnlockHandoff",
          tab: "behavior",
          sectionId: "contactAuth",
        },
      ]);
    });

    test("no flag with the handoff off — that is the working unlock setup", () => {
      expect(
        computeConfigIssues({
          ...unlocking,
          contactAuthHandoffEnabled: false,
          // A deny message, so the silent-refusal check below does not fire instead.
          contactAuthDenyMessage: "Envie seu código de acesso.",
        }),
      ).toEqual([]);
    });

    test("no flag when the gate itself is off", () => {
      expect(
        computeConfigIssues({ ...unlocking, contactAuthEnabled: false }),
      ).toEqual([]);
    });
  });

  // The other end: refuse, say nothing, hand nobody the conversation. The customer's message goes
  // unanswered with no sign anything happened, and only a private note records it.
  describe("a refusal that reaches nobody", () => {
    const gated = {
      ...base,
      contactAuthEnabled: true,
      contactAuthUrl: "https://ops.example.com/authorize",
    };

    test("flags a gate with no deny message and no handoff", () => {
      expect(
        computeConfigIssues({ ...gated, contactAuthHandoffEnabled: false }),
      ).toEqual([
        {
          key: "contactAuthSilentRefusal",
          tab: "behavior",
          sectionId: "contactAuth",
        },
      ]);
    });

    test("a deny message alone clears it — silence towards a stranger is a choice", () => {
      expect(
        computeConfigIssues({
          ...gated,
          contactAuthHandoffEnabled: false,
          contactAuthDenyMessage: "Atendemos apenas clientes cadastrados.",
        }),
      ).toEqual([]);
    });

    test("the handoff alone clears it — a human takes it from there", () => {
      expect(
        computeConfigIssues({ ...gated, contactAuthHandoffEnabled: true }),
      ).toEqual([]);
    });

    test("whitespace is not a deny message", () => {
      expect(
        computeConfigIssues({
          ...gated,
          contactAuthHandoffEnabled: false,
          contactAuthDenyMessage: "   ",
        }).map((i) => i.key),
      ).toEqual(["contactAuthSilentRefusal"]);
    });
  });

  // An enabled gate with no usable endpoint. `readContactAuthConfig` normalizes a missing or
  // malformed URL to null and keeps `enabled` as it found it, so REST and MCP can store the pair —
  // and the runtime then fails closed on EVERY message with `not_configured`. Silent by
  // construction: the agent stops answering and nothing on the page says why.
  describe("an enabled gate with no endpoint", () => {
    test("flags a gate with no URL, deep-linking to behavior/contactAuth", () => {
      expect(
        computeConfigIssues({
          ...base,
          contactAuthEnabled: true,
          contactAuthDenyMessage: "Atendemos apenas clientes cadastrados.",
        }),
      ).toEqual([
        { key: "contactAuthNoUrl", tab: "behavior", sectionId: "contactAuth" },
      ]);
    });

    test("whitespace is not a URL", () => {
      expect(
        computeConfigIssues({
          ...base,
          contactAuthEnabled: true,
          contactAuthUrl: "   ",
          contactAuthDenyMessage: "Atendemos apenas clientes cadastrados.",
        }).map((i) => i.key),
      ).toEqual(["contactAuthNoUrl"]);
    });

    test("no flag when the gate is off — an unused URL field is not a problem", () => {
      expect(
        computeConfigIssues({ ...base, contactAuthEnabled: false }),
      ).toEqual([]);
    });
  });

  test("a targetless textCap issue has no action, and everything else does", () => {
    expect(
      issueHasAction({ key: "textCap", field: "toolGuidance.private_note" }),
    ).toBe(false);
    expect(
      issueHasAction({
        key: "textCap",
        tab: "guardrails",
        sectionId: "gr-policy",
      }),
    ).toBe(true);
    expect(issueHasAction({ key: "embedding" })).toBe(true);
    expect(
      issueHasAction({ key: "embedding", pending: true, vaultId: "7" }),
    ).toBe(true);
    expect(issueHasAction({ key: "knowledge", knowledgeBaseId: "1" })).toBe(
      true,
    );
  });
});
