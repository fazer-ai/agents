import { describe, expect, test } from "bun:test";
import { readLimitsConfig } from "@/modules/agents/limits";

// readLimitsConfig is the single source of defaults + clamping for agent.settings.limits, and all
// three transports (REST / MCP / UI) project through it. The two memory knobs default to OFF: an
// instance that upgrades must not silently start forgetting conversations.

describe("readLimitsConfig", () => {
  test("defaults leave both memory knobs off", () => {
    for (const input of [undefined, null, {}, { limits: {} }, "nonsense"]) {
      const cfg = readLimitsConfig(input);
      expect(cfg.maxHistoryTokens).toBeNull();
      expect(cfg.forgetResolvedAfterDays).toBeNull();
      expect(cfg.maxToolCalls).toBe(10);
    }
  });

  test("reads and rounds the memory knobs", () => {
    const cfg = readLimitsConfig({
      limits: { maxHistoryTokens: 12_000.4, forgetResolvedAfterDays: 7 },
    });
    expect(cfg.maxHistoryTokens).toBe(12_000);
    expect(cfg.forgetResolvedAfterDays).toBe(7);
  });

  test("clamps a ceiling that would squeeze out the current conversation", () => {
    // Under the floor the model loses the very turn it is answering, which reads as amnesia rather
    // than as thrift — so a too-small number is raised, not honored.
    expect(
      readLimitsConfig({ limits: { maxHistoryTokens: 5 } }).maxHistoryTokens,
    ).toBe(2_000);
  });

  test("zero and negative mean OFF, not 'the tightest possible setting'", () => {
    // The tempting alternative — clamping up to the minimum — would turn an operator typing 0
    // ("no trimming, please") into the most aggressive trim available.
    for (const v of [0, -1, -9999]) {
      expect(
        readLimitsConfig({ limits: { maxHistoryTokens: v } }).maxHistoryTokens,
      ).toBeNull();
      expect(
        readLimitsConfig({ limits: { forgetResolvedAfterDays: v } })
          .forgetResolvedAfterDays,
      ).toBeNull();
    }
  });

  test("ignores non-numeric junk without disturbing the other keys", () => {
    const cfg = readLimitsConfig({
      limits: {
        maxToolCalls: 4,
        maxHistoryTokens: "12000",
        forgetResolvedAfterDays: Number.NaN,
      },
    });
    expect(cfg.maxToolCalls).toBe(4);
    expect(cfg.maxHistoryTokens).toBeNull();
    expect(cfg.forgetResolvedAfterDays).toBeNull();
  });
});
