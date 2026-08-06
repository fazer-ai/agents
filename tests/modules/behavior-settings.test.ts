import { describe, expect, test } from "bun:test";
import {
  BEHAVIOR_SETTINGS_KEYS,
  mergeBehaviorSettings,
  readBehaviorSettings,
} from "@/modules/agents/behavior-settings";

// vision is part of the shared behavior surface (so it is settable via the MCP agent_settings_set
// partial-merge path, like stt/tts). These cover the wiring without a DB.
describe("behavior-settings — vision", () => {
  test("vision is an owned key and projects defaults when absent", () => {
    expect(BEHAVIOR_SETTINGS_KEYS).toContain("vision");
    const b = readBehaviorSettings({});
    expect(b.vision.enabled).toBe(false);
    expect(b.vision.provider).toBe("openai");
  });

  test("a partial vision patch merges + normalizes; unknown bag keys are preserved", () => {
    const current = {
      foo: "keep",
      vision: { enabled: false, provider: "openai" },
    };
    const next = mergeBehaviorSettings(current, {
      vision: { enabled: true, provider: "gemini", credentialRef: "vault:5" },
    });
    const v = next.vision as Record<string, unknown>;
    expect(v.enabled).toBe(true);
    expect(v.provider).toBe("gemini");
    expect(v.credentialRef).toBe("vault:5");
    // a non-behavior key in the bag survives the merge
    expect(next.foo).toBe("keep");
  });

  test("an unknown vision provider is clamped to the default on write", () => {
    const next = mergeBehaviorSettings(
      {},
      { vision: { enabled: true, provider: "bogus" } },
    );
    const v = next.vision as Record<string, unknown>;
    expect(v.provider).toBe("openai");
    expect(v.enabled).toBe(true);
  });
});

// NOTE: attributeContext rides the same surface, so REST/UI/MCP project the same normalized value.
describe("behavior-settings — attributeContext", () => {
  test("it is an owned key and projects empty scopes when absent", () => {
    expect(BEHAVIOR_SETTINGS_KEYS).toContain("attributeContext");
    expect(readBehaviorSettings({}).attributeContext).toEqual({
      conversation: [],
      contact: [],
      task: [],
    });
  });

  test("a partial patch replaces only the given scope and is normalized on write", () => {
    const current = {
      attributeContext: {
        conversation: ["origem"],
        contact: ["plano"],
        task: ["orcamento"],
      },
    };
    const next = mergeBehaviorSettings(current, {
      attributeContext: { contact: [" cpf ", "cpf", ""] },
    });
    // NOTE: Both unspecified scopes survive with their real selections — a patch that touches one
    // scope must not silently empty the others (which `task: []` alone would not have caught).
    expect(next.attributeContext).toEqual({
      conversation: ["origem"],
      contact: ["cpf"],
      task: ["orcamento"],
    });
    expect(readBehaviorSettings(next).attributeContext).toEqual({
      conversation: ["origem"],
      contact: ["cpf"],
      task: ["orcamento"],
    });
  });

  test("the prompt-growth bounds hold on the write path too (20 keys, 64 chars)", () => {
    const next = mergeBehaviorSettings(
      {},
      {
        attributeContext: {
          conversation: Array.from({ length: 25 }, (_, i) => `k${i}`),
          // NOTE: An over-long key is DROPPED, not truncated — a truncated key would silently point
          // at a different (or nonexistent) Chatwoot attribute.
          contact: ["x".repeat(65), "plano"],
        },
      },
    );
    expect(readBehaviorSettings(next).attributeContext).toEqual({
      conversation: Array.from({ length: 20 }, (_, i) => `k${i}`),
      contact: ["plano"],
      task: [],
    });
  });
});
