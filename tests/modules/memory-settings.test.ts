import { describe, expect, test } from "bun:test";
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
