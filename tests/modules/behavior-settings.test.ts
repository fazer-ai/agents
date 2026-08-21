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

// The per-agent switch for logging tool VALUES instead of their shape rides the same surface, so the
// editor, REST and MCP all project the one normalized value (issue #78).
describe("behavior-settings — observability", () => {
  test("it is an owned key and defaults to off", () => {
    expect(BEHAVIOR_SETTINGS_KEYS).toContain("observability");
    expect(readBehaviorSettings({}).observability).toEqual({
      logToolValues: false,
    });
  });

  test("a patch is normalized on write and leaves other blocks alone", () => {
    const next = mergeBehaviorSettings(
      { limits: { maxToolCalls: 7 } },
      { observability: { logToolValues: "true" } },
    );
    expect(next.observability).toEqual({ logToolValues: true });
    // The limits block is re-read through its typed reader, so it comes back normalized in full:
    // the untouched tool-call cap plus the history ceiling explicitly at "off".
    expect(next.limits).toEqual({ maxToolCalls: 7, maxHistoryTokens: null });
  });
});

// The merge contract goes all the way down (issue #184). One shallow spread per block kept the
// promise at the top level of a block and broke it one step in: a patch that named a SUB-object
// replaced it whole, and because each block is then re-read through its typed reader, the hole came
// back filled with defaults rather than absent — a complete, plausible block with the operator's
// values gone.
describe("behavior-settings — a patch into a nested block", () => {
  const configured = {
    guardrails: {
      enabled: true,
      input: {
        enabled: true,
        action: "silent",
        templateMessage: "Vou chamar um atendente para você.",
        checks: { toxicity: false, competitorMentions: true },
      },
    },
  };

  test("turning a direction off keeps everything else the operator set", () => {
    const next = mergeBehaviorSettings(configured, {
      guardrails: { input: { enabled: false } },
    });
    const input = (next.guardrails as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
    expect(input.enabled).toBe(false);
    // The two that reach the customer. `silent` means send NOTHING on a violation; letting it fall
    // back to `template` makes the agent start replying where silence was chosen, with the
    // product's own wording in place of the operator's sentence.
    expect(input.action).toBe("silent");
    expect(input.templateMessage).toBe("Vou chamar um atendente para você.");
    expect(input.checks).toMatchObject({
      toxicity: false,
      competitorMentions: true,
    });
  });

  test("a nested patch still overrides what it does name", () => {
    const next = mergeBehaviorSettings(configured, {
      guardrails: { input: { templateMessage: "Só um instante." } },
    });
    const input = (next.guardrails as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
    expect(input.templateMessage).toBe("Só um instante.");
    expect(input.action).toBe("silent");
  });

  test("an untouched sibling direction is left alone", () => {
    const next = mergeBehaviorSettings(
      {
        guardrails: {
          ...configured.guardrails,
          output: { enabled: true, templateMessage: "Não posso responder." },
        },
      },
      { guardrails: { input: { enabled: false } } },
    );
    const output = (next.guardrails as Record<string, unknown>)
      .output as Record<string, unknown>;
    expect(output.templateMessage).toBe("Não posso responder.");
  });

  // A list patch means the new list. Deep-merging arrays would make a shorter `steps` or a smaller
  // attribute scope impossible to express, which is the opposite of what an operator means by
  // sending one.
  test("a list is still replaced wholesale, not merged element by element", () => {
    const next = mergeBehaviorSettings(
      { attributeContext: { conversation: ["a", "b", "c"] } },
      { attributeContext: { conversation: ["a"] } },
    );
    expect(
      (next.attributeContext as Record<string, unknown>).conversation,
    ).toEqual(["a"]);
  });
});
