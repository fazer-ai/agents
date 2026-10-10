import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  BEHAVIOR_SETTINGS_KEYS,
  behaviorSettingsMaxDepth,
  MERGE_MAX_DEPTH_FOR_TESTS,
  mergeBehaviorSettings,
  readBehaviorSettings,
} from "@/modules/agents/behavior-settings";
import { readLimitsConfig } from "@/modules/agents/limits";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";

// EVERY BLOCK THIS SURFACE OWNS IS WRITTEN BACK NORMALIZED, and the check is over the key list
// rather than over the eighteen assignments that implement it.
//
// The merge re-reads the patched bag through the typed readers to clamp and validate it, and then
// has to STORE what it read. A block that is merged but not written back leaves the raw value in
// `agent.settings` while every projection shows the normalized one, so the export, the MCP read and a
// diff between two agents disagree. It is silent by construction (the readers normalize again on the
// way out), so it is asserted per KEY, behaviourally, rather than trusted to each assignment.
describe("behavior-settings — the merge stores every block it owns", () => {
  // The two blocks whose stored form is deliberately NOT the read form, each for a reason at its own
  // assignment: `observability` persists through `storableObservability` because `fullDetail` is
  // DERIVED and storing it would freeze a mode that is supposed to expire; `grounding` is persisted
  // only when the patch touched it, so an untouched bag keeps whatever it had.
  const NOT_THE_READ_SHAPE = new Set(["observability", "grounding"]);

  for (const key of BEHAVIOR_SETTINGS_KEYS) {
    if (NOT_THE_READ_SHAPE.has(key)) continue;
    test(`${key} comes back agreeing with its own reader`, () => {
      const merged = mergeBehaviorSettings({}, { [key]: {} });
      const stored = (merged as Record<string, unknown>)[key];
      // The stored bag and the projection of it are the same thing, which is exactly what the
      // write-back exists to make true.
      expect(stored).toEqual(
        (readBehaviorSettings(merged) as unknown as Record<string, unknown>)[
          key
        ],
      );
    });
  }

  test("the loop actually covers the blocks, including the newest", () => {
    const covered = BEHAVIOR_SETTINGS_KEYS.filter(
      (k) => !NOT_THE_READ_SHAPE.has(k),
    );
    expect(covered.length).toBeGreaterThanOrEqual(15);
    expect(covered).toContain("modelFallback");
  });
});

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
// editor, REST and MCP all project the one normalized value.
describe("behavior-settings — observability", () => {
  test("it is an owned key and defaults to off", () => {
    expect(BEHAVIOR_SETTINGS_KEYS).toContain("observability");
    expect(readBehaviorSettings({}).observability).toEqual({
      logToolValues: false,
      fullDetail: false,
      fullDetailUntil: null,
    });
  });

  test("a patch is normalized on write and leaves other blocks alone", () => {
    const next = mergeBehaviorSettings(
      { limits: { maxToolCalls: 7 } },
      { observability: { logToolValues: "true" } },
    );
    // The STORED shape, not the read shape: `fullDetail` is derived on read and must never be
    // persisted, or a bag can say "armed" an hour after the window closed.
    expect(next.observability).toEqual({
      logToolValues: true,
      fullDetailUntil: null,
    });
    // The limits block is re-read through its typed reader, so it comes back normalized in full:
    // the untouched tool-call cap plus the history ceiling explicitly at "off", and the silence
    // retry at its default.
    expect(next.limits).toEqual({
      maxToolCalls: 7,
      maxHistoryTokens: null,
      retrySilence: true,
      maxTurnsPerHour: 60,
    });
  });
});

// "No limit" is a stored 0, and the merge writes the read shape back: if that shape said null, an
// unrelated MCP edit would store null, which reads as the default and turns the limit back on.
describe("behavior-settings — a disabled turn limit through a merge", () => {
  const limitsSchema = z.object(BEHAVIOR_PATCH_SHAPE).shape.limits;

  test("an unrelated patch keeps the stored 0, and the stored block passes the schema", () => {
    const next = mergeBehaviorSettings(
      { limits: { maxToolCalls: 7, maxTurnsPerHour: 0 } },
      { observability: { logToolValues: "true" } },
    );
    expect((next.limits as Record<string, unknown>).maxTurnsPerHour).toBe(0);
    expect(readLimitsConfig(next).maxTurnsPerHour).toBe(0);
    expect(limitsSchema.safeParse(next.limits).success).toBe(true);
  });

  test("a patch that turns it off stores 0", () => {
    const next = mergeBehaviorSettings(
      { limits: { maxTurnsPerHour: 20 } },
      { limits: { maxTurnsPerHour: 0 } },
    );
    expect((next.limits as Record<string, unknown>).maxTurnsPerHour).toBe(0);
    expect(limitsSchema.safeParse(next.limits).success).toBe(true);
  });
});

// The merge contract goes all the way down. A shallow spread per block would let a patch that names a
// SUB-object replace it whole, and since each block is re-read through its typed reader, the hole comes
// back filled with defaults: a complete, plausible block with the operator's values gone.
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

  // The descent is BOUNDED. Both sides of the merge are caller-supplied and the settings schema
  // accepts arbitrary nested `unknown`, so an unbounded recursion turns "store a deep object, then
  // patch it" into a RangeError that escapes the write and leaves the agent's settings unwritable
  // until the row is repaired by hand.
  test("a pathologically deep patch is bounded instead of blowing the stack", () => {
    const deep = (n: number): Record<string, unknown> => {
      let o: Record<string, unknown> = { leaf: 1 };
      for (let i = 0; i < n; i++) o = { k: o };
      return o;
    };
    expect(() =>
      mergeBehaviorSettings(
        { memory: { compaction: deep(50_000) } },
        { memory: { compaction: deep(50_000) } },
      ),
    ).not.toThrow();
  });

  // The cap is not a number someone liked: it has to clear the deepest shape the readers actually
  // produce, or a block nested past it would silently lose the operator's values. Growing a deeper
  // block fails HERE, where the fix is one constant, instead of in the field.
  test("the depth cap clears the deepest shape the readers produce", () => {
    expect(behaviorSettingsMaxDepth()).toBeLessThan(MERGE_MAX_DEPTH_FOR_TESTS);
  });
});

// The merge re-reads every block through its typed reader and writes the result back, so a reader
// that answers a DERIVED field would persist it. `observability.fullDetail` is exactly that field:
// it is computed from `fullDetailUntil` on every read, and a bag holding it would let the stored
// answer and the computed one disagree the moment the window closes.
describe("behavior-settings — the merge stores what is stored, not what is derived", () => {
  const armed = new Date(Date.now() + 3_600_000).toISOString();

  test("an armed window survives a patch to an unrelated block", () => {
    const next = mergeBehaviorSettings(
      { observability: { fullDetailUntil: armed } },
      { limits: { maxToolCalls: 7 } },
    );
    expect(next.observability).toEqual({
      logToolValues: false,
      fullDetailUntil: armed,
    });
  });

  test("a window that closed is written back as off", () => {
    const next = mergeBehaviorSettings(
      {
        observability: {
          fullDetailUntil: new Date(Date.now() - 1000).toISOString(),
        },
      },
      { limits: { maxToolCalls: 7 } },
    );
    expect(
      (next.observability as { fullDetailUntil: unknown }).fullDetailUntil,
    ).toBeNull();
  });
});
