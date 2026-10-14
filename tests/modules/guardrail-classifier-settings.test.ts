import { describe, expect, test } from "bun:test";
import { assertSettingsClosedValues } from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import * as settings from "@/modules/guardrails/settings";

// The guardrails' classifier settings: the chat verdict stays the default, the
// decisions block reads with defaults and clamps, and the write boundary refuses what the screening
// could not run. Read through the module namespace so a missing export fails the assertion, not
// the file's load.
const readGuardrailsConfig = settings.readGuardrailsConfig as (
  s: unknown,
) => settings.GuardrailsConfig;
const guardrailCredentialRef = (
  settings as unknown as {
    guardrailCredentialRef: (c: unknown) => string | null;
  }
).guardrailCredentialRef;

describe("settings", () => {
  test("the chat verdict is the default, and an old block keeps it", () => {
    expect(readGuardrailsConfig({}).classifier).toBe("chat");
    const old = readGuardrailsConfig({
      guardrails: {
        enabled: true,
        provider: "openai",
        credentialRef: "vault:2",
      },
    });
    expect(old.classifier).toBe("chat");
    expect(guardrailCredentialRef(old)).toBe("vault:2");
  });

  test("the decisions block reads with defaults, clamps thresholds and drops junk", () => {
    const cfg = readGuardrailsConfig({
      guardrails: {
        classifier: "decisions",
        credentialRef: "vault:2",
        decisions: {
          provider: "openai",
          credentialRef: "vault:9",
          thresholds: { toxicity: 0.3, unsafeContent: 7, customPolicy: "x" },
        },
      },
    });
    expect(cfg.classifier).toBe("decisions");
    expect(cfg.decisions.provider).toBe("openai");
    expect(cfg.decisions.model).toBe("gpt-6-luna");
    expect(cfg.decisions.thresholds.toxicity).toBe(0.3);
    expect(cfg.decisions.thresholds.unsafeContent).toBe(1);
    expect(cfg.decisions.thresholds.customPolicy).toBe(0.8);
    expect(cfg.decisions.thresholds.answerRelevance).toBe(0.8);
    // The screening's credential is the classifier's, while the chat one stays stored.
    expect(guardrailCredentialRef(cfg)).toBe("vault:9");
    expect(cfg.credentialRef).toBe("vault:2");
  });

  test("an unknown classifier or provider falls back to the defaults", () => {
    const cfg = readGuardrailsConfig({
      guardrails: {
        classifier: "anthropic",
        decisions: { provider: "anthropic" },
      },
    });
    expect(cfg.classifier).toBe("chat");
    expect(cfg.decisions.provider).toBe("typesafe");
    expect(cfg.decisions.model).toBe("jev-latest");
  });
});

describe("write boundary", () => {
  const schema = BEHAVIOR_PATCH_SHAPE.guardrails;
  const issuesOf = (v: unknown) => {
    const r = schema.safeParse(v);
    return r.success ? [] : r.error.issues;
  };

  test("generated is refused on either direction under the decisions classifier", () => {
    for (const dir of ["input", "output"] as const) {
      const issues = issuesOf({
        classifier: "decisions",
        [dir]: { action: "generated" },
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toEqual([dir, "action"]);
      expect(issues[0]?.code).toBe("custom");
    }
    expect(
      issuesOf({ classifier: "chat", input: { action: "generated" } }),
    ).toEqual([]);
    expect(issuesOf({ input: { action: "generated" } })).toEqual([]);
    expect(
      issuesOf({ classifier: "decisions", input: { action: "template" } }),
    ).toEqual([]);
  });

  test("a normalized block, as GET returns it, is refused with generated under the classifier", () => {
    // The reader fills the input's reply-only checks, which fail their `never` and are let through
    // by the boundary; the refusal of `generated` must not ride on them.
    const read = readGuardrailsConfig({
      guardrails: { enabled: true, output: { action: "generated" } },
    });
    const write = (g: unknown, stored: unknown) => () =>
      assertSettingsClosedValues({ guardrails: g }, { guardrails: stored });
    expect(write({ ...read, classifier: "decisions" }, read)).toThrow();
    expect(write(read, read)).not.toThrow();
    const asTemplate = {
      ...read,
      classifier: "decisions",
      output: { ...read.output, action: "template" },
    };
    expect(write(asTemplate, read)).not.toThrow();
    expect(
      write(
        { ...asTemplate, input: { ...read.input, action: "generated" } },
        asTemplate,
      ),
    ).toThrow();
  });

  test("a provider outside the list, a threshold that is not a number or outside 0..1 are refused", () => {
    expect(issuesOf({ decisions: { provider: "anthropic" } })[0]?.path).toEqual(
      ["decisions", "provider"],
    );
    expect(
      issuesOf({ decisions: { thresholds: { toxicity: "alto" } } })[0]?.path,
    ).toEqual(["decisions", "thresholds", "toxicity"]);
    expect(
      issuesOf({ decisions: { thresholds: { toxicity: -0.5 } } })[0]?.path,
    ).toEqual(["decisions", "thresholds", "toxicity"]);
    expect(
      issuesOf({ decisions: { thresholds: { customPolicy: 1.5 } } })[0]?.path,
    ).toEqual(["decisions", "thresholds", "customPolicy"]);
    expect(issuesOf({ classifier: "llm" })[0]?.path).toEqual(["classifier"]);
    expect(
      issuesOf({
        classifier: "decisions",
        decisions: {
          provider: "typesafe",
          credentialRef: "vault:1",
          thresholds: { toxicity: 0, unsafeContent: 1 },
        },
      }),
    ).toEqual([]);
  });
});
