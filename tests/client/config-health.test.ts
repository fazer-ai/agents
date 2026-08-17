import { describe, expect, test } from "bun:test";
import { computeConfigIssues } from "@/client/lib/configHealth";

// Phase E: detect features turned on without the credential they need (the import that strips
// secrets is the common trigger), each carrying a deep-link target (tab + section anchor).
const base = {
  modelProvider: "openai",
  modelCredentialRef: "vault:1",
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

    // REST and MCP accept a credential with no provider (the same vendor, another account key), and
    // the runtime SKIPS every rewrite when that credential does not resolve. Gating the check on the
    // provider being set hid exactly that case.
    test("a credential of its own with the provider inherited is still checked", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "",
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

    test("a resolvable credential with the provider inherited raises nothing", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "",
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
          modelProvider: "openai-compatible",
          modelBaseURL: "http://llama:8080/v1",
          ttsNormalize: true,
          ttsNormalizeProvider: "openai-compatible",
        }),
      ).toEqual([]);
    });

    // A provider name REST or MCP stored that we do not support. It is refused for a reason that is
    // NOT a missing key, so telling the operator to add a credential would send them down the wrong
    // path entirely.
    test("an unsupported provider name is not reported as a missing credential", () => {
      expect(
        computeConfigIssues({
          ...audio,
          ttsNormalize: true,
          ttsNormalizeProvider: "anthropik",
        }),
      ).toEqual([]);
    });
  });
});
