import { describe, expect, test } from "bun:test";
import { assertSettingsClosedValues } from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import {
  GUARDRAILS_DEFAULTS,
  readGuardrailsConfig,
  resolveGroundingReviewer,
} from "@/modules/guardrails/settings";

// `guardrails.factualGrounding` as stored, read and written: off and observing by default, the
// reviewer falling back to the guardrails model, and the write boundary refusing an unknown action.

describe("reading it", () => {
  test("an agent saved before the check exists reads it off, observing, with no sources", () => {
    const fg = readGuardrailsConfig({
      guardrails: { enabled: true },
    }).factualGrounding;
    expect(fg).toEqual(GUARDRAILS_DEFAULTS.factualGrounding);
    expect(fg.enabled).toBe(false);
    expect(fg.action).toBe("observe");
  });

  test("source names are trimmed and deduplicated, and junk is dropped", () => {
    const fg = readGuardrailsConfig({
      guardrails: {
        factualGrounding: {
          sourceTools: [" catalogo ", "catalogo", 3, "", "search_knowledge"],
          action: "corrigir",
          contextMessages: 99,
        },
      },
    }).factualGrounding;
    expect(fg.sourceTools).toEqual(["catalogo", "search_knowledge"]);
    expect(fg.action).toBe("observe");
    expect(fg.contextMessages).toBe(20);
  });

  test("the rewrite consults the sources by default, three calls at most, and a stored cap is clamped", () => {
    const d = readGuardrailsConfig({}).factualGrounding;
    expect([d.reviseWithTools, d.reviseMaxToolCalls]).toEqual([true, 3]);
    const fg = readGuardrailsConfig({
      guardrails: {
        factualGrounding: { reviseWithTools: false, reviseMaxToolCalls: 40 },
      },
    }).factualGrounding;
    expect([fg.reviseWithTools, fg.reviseMaxToolCalls]).toEqual([false, 5]);
    expect(
      readGuardrailsConfig({
        guardrails: { factualGrounding: { reviseWithTools: "sim" } },
      }).factualGrounding.reviseWithTools,
    ).toBe(true);
  });
});

// The reviewer as an override of the guardrails chat model, through the same resolver as every other
// own-model field: the bug each case catches is a key or a model landing where it was not picked for.
describe("resolving the reviewer", () => {
  const KEYS = {
    ownKey: "sk-own",
    ownBaseUrl: null,
    parentKey: "sk-guardrails",
    parentBaseUrl: null,
  };
  const guard = (factualGrounding: Record<string, unknown>) =>
    readGuardrailsConfig({
      guardrails: {
        provider: "openai",
        model: "m-guard",
        credentialRef: "vault:1",
        factualGrounding,
      },
    });

  test("nothing set runs on the guardrails model and its key", () => {
    expect(resolveGroundingReviewer(guard({}), KEYS)).toEqual({
      runnable: true,
      provider: "openai",
      model: "m-guard",
      baseURL: null,
      apiKey: "sk-guardrails",
    });
  });

  test("a model of its own on the same provider keeps the guardrails key", () => {
    expect(
      resolveGroundingReviewer(
        guard({ provider: "openai", model: "m-review" }),
        KEYS,
      ),
    ).toMatchObject({
      runnable: true,
      model: "m-review",
      apiKey: "sk-guardrails",
    });
  });

  // The bug it catches: a guardrails model on a keyless OpenAI-compatible endpoint refused as a
  // missing key for the reviewer that inherits it, so no reply was reviewed.
  test("inheriting a keyless compatible guardrails model runs keyless, a configured key that did not resolve does not", () => {
    const keyless = readGuardrailsConfig({
      guardrails: {
        provider: "openai-compatible",
        model: "m-local",
        baseURL: "http://modelo.local/v1",
        factualGrounding: {},
      },
    });
    const noKeys = { ...KEYS, ownKey: "", parentKey: "" };
    expect([
      resolveGroundingReviewer(keyless, noKeys),
      resolveGroundingReviewer(guard({}), noKeys),
    ]).toEqual([
      {
        runnable: true,
        provider: "openai-compatible",
        model: "m-local",
        baseURL: "http://modelo.local/v1",
        apiKey: "",
      },
      {
        runnable: false,
        reason: "credential_not_found",
        provider: "openai",
        model: "m-guard",
      },
    ]);
  });

  test("a model or a key stored with no provider is refused, as every override refuses it", () => {
    for (const fg of [{ model: "m-orphan" }, { credentialRef: "vault:9" }])
      expect(resolveGroundingReviewer(guard(fg), KEYS)).toMatchObject({
        runnable: false,
        reason: "override_without_provider",
      });
  });

  test("another provider runs on its own key, and without one it is refused, never on the guardrails key", () => {
    expect(
      resolveGroundingReviewer(
        guard({ provider: "anthropic", credentialRef: "vault:9" }),
        KEYS,
      ),
    ).toMatchObject({
      runnable: true,
      provider: "anthropic",
      apiKey: "sk-own",
    });
    expect(
      resolveGroundingReviewer(guard({ provider: "anthropic" }), KEYS),
    ).toMatchObject({ runnable: false, reason: "credential_required" });
    expect(
      resolveGroundingReviewer(
        guard({ provider: "anthropic", credentialRef: "vault:9" }),
        { ...KEYS, ownKey: "" },
      ),
    ).toMatchObject({ runnable: false, reason: "credential_not_found" });
  });

  test("a keyless compatible endpoint runs on no key at all", () => {
    expect(
      resolveGroundingReviewer(
        guard({
          provider: "openai-compatible",
          model: "m-local",
          baseURL: "http://revisor.local/v1",
        }),
        KEYS,
      ),
    ).toEqual({
      runnable: true,
      provider: "openai-compatible",
      model: "m-local",
      baseURL: "http://revisor.local/v1",
      apiKey: "",
    });
  });
});

describe("writing it", () => {
  const schema = BEHAVIOR_PATCH_SHAPE.guardrails;
  test("the four actions are accepted and anything else is refused", () => {
    for (const action of ["observe", "revise", "template", "handoff"])
      expect(schema.safeParse({ factualGrounding: { action } }).success).toBe(
        true,
      );
    for (const action of ["corrigir", "generated", "silent"])
      expect(schema.safeParse({ factualGrounding: { action } }).success).toBe(
        false,
      );
  });

  test("an out-of-range window is refused, not clamped", () => {
    expect(
      schema.safeParse({ factualGrounding: { contextMessages: 21 } }).success,
    ).toBe(false);
    expect(() =>
      assertSettingsClosedValues(
        { guardrails: { factualGrounding: { action: "revise" } } },
        {},
      ),
    ).not.toThrow();
  });

  test("the rewrite's cap is refused outside 1 to 5, and the switch only as a boolean", () => {
    for (const reviseMaxToolCalls of [0, 6, 1000, -1, 2.5])
      expect(
        schema.safeParse({ factualGrounding: { reviseMaxToolCalls } }).success,
      ).toBe(false);
    for (const reviseMaxToolCalls of [1, 3, 5])
      expect(
        schema.safeParse({ factualGrounding: { reviseMaxToolCalls } }).success,
      ).toBe(true);
    expect(
      schema.safeParse({ factualGrounding: { reviseWithTools: "sim" } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ factualGrounding: { reviseWithTools: false } })
        .success,
    ).toBe(true);
  });
});
