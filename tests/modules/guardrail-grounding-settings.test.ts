import { describe, expect, test } from "bun:test";
import { assertSettingsClosedValues } from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import {
  GUARDRAILS_DEFAULTS,
  groundingReviewer,
  readGuardrailsConfig,
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

  test("the reviewer is the guardrails model until the check names its own", () => {
    const shared = readGuardrailsConfig({
      guardrails: {
        provider: "openai",
        model: "m-guard",
        credentialRef: "vault:1",
        factualGrounding: { model: "ignored", credentialRef: "vault:9" },
      },
    });
    expect(groundingReviewer(shared)).toEqual({
      provider: "openai",
      model: "m-guard",
      credentialRef: "vault:1",
      baseURL: null,
    });
    const own = readGuardrailsConfig({
      guardrails: {
        provider: "openai",
        credentialRef: "vault:1",
        factualGrounding: {
          provider: "anthropic",
          model: "m-review",
          credentialRef: "vault:9",
        },
      },
    });
    expect(groundingReviewer(own)).toMatchObject({
      provider: "anthropic",
      model: "m-review",
      credentialRef: "vault:9",
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
});
