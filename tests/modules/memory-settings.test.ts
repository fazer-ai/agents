import { describe, expect, test } from "bun:test";
import { mergeBehaviorSettings } from "@/modules/agents/behavior-settings";
import { readMemoryConfig } from "@/modules/memory/settings";

describe("readMemoryConfig", () => {
  // The default is the whole product decision: a settings bag written before this feature existed
  // has no `memory` key at all, and every one of those must compact. Reading absent as "off" would
  // mean the measured problem stays exactly where it is on every existing install.
  const absent = [
    undefined,
    null,
    {},
    { memory: null },
    { memory: {} },
    { memory: { compaction: {} } },
    { memory: "sim" },
    { memory: { compaction: "sim" } },
  ];
  for (const [i, settings] of absent.entries()) {
    test(`absent or malformed reads as ON (case ${i})`, () => {
      expect(readMemoryConfig(settings).compaction.enabled).toBe(true);
    });
  }

  test("only an explicit false turns it off", () => {
    expect(
      readMemoryConfig({ memory: { compaction: { enabled: false } } })
        .compaction.enabled,
    ).toBe(false);
    // the editor round-trips through JSON, where a checkbox can arrive as a string
    expect(
      readMemoryConfig({ memory: { compaction: { enabled: "false" } } })
        .compaction.enabled,
    ).toBe(false);
  });

  test("an explicit true stays on", () => {
    expect(
      readMemoryConfig({ memory: { compaction: { enabled: true } } }).compaction
        .enabled,
    ).toBe(true);
  });
});

// The summariser's model override. The safety property of every one of these is the same: whatever
// the bag holds, the fallback has to be "the agent's model", because compaction ships ON and a
// reader that resolved a half-written override into something unrunnable would stop summarising on
// an install whose operator never opened this field.
describe("readMemoryConfig — the summariser's own model", () => {
  test("the four override fields read back, trimmed", () => {
    const c = readMemoryConfig({
      memory: {
        compaction: {
          provider: " openai ",
          model: " gpt-5.4-mini ",
          credentialRef: " vault:7 ",
          baseURL: " https://proxy.example/v1 ",
        },
      },
    }).compaction;
    expect(c).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-5.4-mini",
      credentialRef: "vault:7",
      baseURL: "https://proxy.example/v1",
    });
  });

  // Blank is not a provider named "": it is the absence of an override, and it is what the editor
  // writes while an operator is mid-edit. Reading it as a value would hand `createChatModel` a
  // provider it does not know, which is a summariser that never runs.
  const blank = ["", "   ", null, 0, false, [], {}, 42];
  for (const [i, v] of blank.entries()) {
    test(`a blank or non-string override reads as inherit (case ${i})`, () => {
      const c = readMemoryConfig({
        memory: {
          compaction: { provider: v, model: v, credentialRef: v, baseURL: v },
        },
      }).compaction;
      expect([c.provider, c.model, c.credentialRef, c.baseURL]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    });
  }
});

// This block is the reason the nested merge had to land first. Before it, a patch naming
// `memory.compaction` replaced that object whole, so an operator who turned compaction off through
// REST or MCP would have silently dropped the model they had configured for it — and the next time
// they turned it back on it would have been running on the agent's model without anyone saying so.
describe("a partial patch into memory.compaction", () => {
  test("turning compaction off keeps the model configured for it", () => {
    const before = {
      memory: {
        compaction: {
          enabled: true,
          provider: "openai",
          model: "gpt-5.4-mini",
          credentialRef: "vault:7",
          baseURL: null,
        },
      },
    };
    const next = mergeBehaviorSettings(before, {
      memory: { compaction: { enabled: false } },
    });
    expect(readMemoryConfig(next).compaction).toEqual({
      enabled: false,
      provider: "openai",
      model: "gpt-5.4-mini",
      credentialRef: "vault:7",
      baseURL: null,
    });
  });

  test("a patch naming only the model leaves the switch alone", () => {
    const next = mergeBehaviorSettings(
      { memory: { compaction: { enabled: false, provider: "openai" } } },
      { memory: { compaction: { model: "gpt-5.4-nano" } } },
    );
    expect(readMemoryConfig(next).compaction).toEqual({
      enabled: false,
      provider: "openai",
      model: "gpt-5.4-nano",
      credentialRef: null,
      baseURL: null,
    });
  });
});
