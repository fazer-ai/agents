import { describe, expect, test } from "bun:test";
import {
  otherInboxesBlocksSave,
  otherInboxesPatch,
  otherInboxesToStored,
} from "@/client/pages/agents/OtherInboxesFields";
import {
  assertSettingsClosedValues,
  type InvalidSettingsValueError,
} from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import {
  OTHER_INBOXES_DEFAULTS,
  OTHER_INBOXES_MAX_INBOXES,
  readOtherInboxesConfig,
} from "@/modules/other-inboxes/settings";

const schema = BEHAVIOR_PATCH_SHAPE.otherInboxes;

describe("otherInboxes settings", () => {
  test("an agent that never configured it reads off, with no inbox", () => {
    expect(readOtherInboxesConfig({})).toEqual(OTHER_INBOXES_DEFAULTS);
    expect(OTHER_INBOXES_DEFAULTS.enabled).toBe(false);
    expect(
      readOtherInboxesConfig({ otherInboxes: { enabled: "true" } }).enabled,
    ).toBe(false);
  });

  test("the write refuses every value outside its range", () => {
    for (const bad of [
      { maxConversations: 0 },
      { maxConversations: 11 },
      { lookbackDays: 0 },
      { lookbackDays: 366 },
      { fullTranscriptMaxChars: 499 },
      { fullTranscriptMaxChars: 8001 },
      { maxConversations: 2.5 },
    ]) {
      expect([bad, schema.safeParse(bad).success]).toEqual([bad, false]);
    }
    for (const edge of [
      { maxConversations: 1 },
      { maxConversations: 10 },
      { lookbackDays: 365 },
      { fullTranscriptMaxChars: 500 },
      { fullTranscriptMaxChars: 8000 },
    ]) {
      expect([edge, schema.safeParse(edge).success]).toEqual([edge, true]);
    }
  });

  test("a value stored past the range by hand is clamped on read", () => {
    const cfg = readOtherInboxesConfig({
      otherInboxes: { enabled: true, maxConversations: 50, lookbackDays: 0 },
    });
    expect(cfg.maxConversations).toBe(10);
    expect(cfg.lookbackDays).toBe(1);
  });

  test("inboxes keep the instance they were picked from, without repeats", () => {
    const cfg = readOtherInboxesConfig({
      otherInboxes: {
        inboxes: [
          { instanceId: 1, inboxId: 7 },
          { instanceId: 1, inboxId: 7 },
          { instanceId: 2, inboxId: 7 },
          { instanceId: 0, inboxId: 8 },
        ],
      },
    });
    expect(cfg.inboxes).toEqual([
      { instanceId: 1, inboxId: 7 },
      { instanceId: 2, inboxId: 7 },
    ]);
  });

  test("the card writes what the reader reads back", () => {
    const stored = otherInboxesToStored({
      enabled: true,
      inboxes: ["3:12", "3:14"],
      maxConversations: "3",
      lookbackDays: "30",
      fullTranscriptMaxChars: "1500",
    });
    expect(readOtherInboxesConfig({ otherInboxes: stored })).toEqual({
      enabled: true,
      inboxes: [
        { instanceId: 3, inboxId: 12 },
        { instanceId: 3, inboxId: 14 },
      ],
      maxConversations: 3,
      lookbackDays: 30,
      fullTranscriptMaxChars: 1500,
    });
  });

  test("a value past the ceiling is refused naming the ceiling and the value sent", () => {
    let err: InvalidSettingsValueError | null = null;
    try {
      assertSettingsClosedValues(
        { otherInboxes: { maxConversations: 11 } },
        {},
      );
    } catch (e) {
      err = e as InvalidSettingsValueError;
    }
    expect(err?.field).toBe("otherInboxes.maxConversations");
    expect(String(err?.translationParams?.expected)).toBe(
      "a number of at most 10",
    );
    expect(err?.translationParams?.got).toBe("11");
  });

  test("a watcher's save keeps the stored block, and a hidden bad number never holds Save", () => {
    const draft = {
      enabled: true,
      inboxes: ["3:12"],
      maxConversations: "",
      lookbackDays: "30",
      fullTranscriptMaxChars: "1500",
    };
    expect(otherInboxesPatch(draft, true)).toEqual({});
    expect(otherInboxesBlocksSave(draft, "monitoring")).toBe(false);
    expect(otherInboxesBlocksSave(draft, "reply")).toBe(true);
    expect(
      otherInboxesBlocksSave({ ...draft, maxConversations: "5" }, "reply"),
    ).toBe(false);
  });

  // The server refuses more than OTHER_INBOXES_MAX_INBOXES; the picker does not cap the count itself.
  test("more inboxes than the cap hold Save while on, and are left out while off", () => {
    const many = Array.from(
      { length: OTHER_INBOXES_MAX_INBOXES + 2 },
      (_, i) => `3:${i + 1}`,
    );
    const draft = {
      enabled: true,
      inboxes: many,
      maxConversations: "5",
      lookbackDays: "30",
      fullTranscriptMaxChars: "1500",
    };
    expect(otherInboxesBlocksSave(draft, "reply")).toBe(true);
    expect(
      otherInboxesBlocksSave(
        {
          ...draft,
          inboxes: many.filter((_, i) => i < OTHER_INBOXES_MAX_INBOXES),
        },
        "reply",
      ),
    ).toBe(false);
    const off = otherInboxesToStored({ ...draft, enabled: false });
    expect(off.inboxes).toHaveLength(OTHER_INBOXES_MAX_INBOXES);
    expect(() =>
      assertSettingsClosedValues({ otherInboxes: off }, {}),
    ).not.toThrow();
  });

  test("switched off, a number out of range is not written and the rest still saves", () => {
    const stored = otherInboxesToStored({
      enabled: false,
      inboxes: [],
      maxConversations: "20",
      lookbackDays: "30",
      fullTranscriptMaxChars: "1500",
    });
    expect(schema.safeParse(stored).success).toBe(true);
    expect(readOtherInboxesConfig({ otherInboxes: stored })).toMatchObject({
      enabled: false,
      maxConversations: 5,
      lookbackDays: 30,
    });
  });
});
