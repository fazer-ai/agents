import { describe, expect, test } from "bun:test";
import {
  type BehaviorState,
  editedBlocks,
} from "@/client/pages/agents/behaviorSave";
import type { ChannelRedirectFormState } from "@/client/pages/agents/ChannelRedirectTab";
import { fromChannelRedirectForm } from "@/client/pages/agents/channelRedirectSave";
import { CHANNEL_REDIRECT_DEFAULTS } from "@/modules/channel-redirect/service";

// A number drawn out of range holds Save, so one that reaches a save sits in a section that is off or
// hidden: typed, then the switch turned off. Sent, the server refuses it and nobody can see the field
// to fix it; it goes back as stored, or is left out for the reader's default.

const edited = (block: string, value: unknown, storedBag: unknown) =>
  editedBlocks(
    { [block]: value },
    { [block]: "form" } as unknown as BehaviorState,
    { [block]: "stored" } as unknown as BehaviorState,
    { [block]: storedBag },
  )[block as "debounce"] as Record<string, unknown>;

describe("a Behavior block saved with a section off", () => {
  test("an out-of-range number goes back as stored", () => {
    const out = edited(
      "debounce",
      { enabled: false, windowSeconds: -10, maxMessagesPerBurst: 5 },
      { enabled: true, windowSeconds: 15 },
    );
    expect(out).toEqual({
      enabled: false,
      windowSeconds: 15,
      maxMessagesPerBurst: 5,
    });
  });

  test("with nothing stored it is left out, for the reader's default", () => {
    const out = edited(
      "debounce",
      { enabled: false, windowSeconds: -10 },
      undefined,
    );
    expect(out).toEqual({ enabled: false });
  });

  test("a follow-up step's delay is judged in its own unit", () => {
    const out = edited(
      "followUp",
      {
        enabled: false,
        steps: [
          { delayValue: 31, delayUnit: "days" },
          { delayValue: 31, delayUnit: "hours" },
        ],
      },
      { steps: [{ delayValue: 2, delayUnit: "days" }] },
    );
    expect(out.steps).toEqual([
      { delayValue: 2, delayUnit: "days" },
      { delayValue: 31, delayUnit: "hours" },
    ]);
  });
});

const form = (over: Partial<ChannelRedirectFormState>) =>
  ({
    enabled: true,
    entryInboxId: "",
    widgetInboxId: null,
    redirectMessage: "{link}",
    resendDelayValue: "2",
    resendDelayUnit: "hours",
    maxResends: "1",
    openWidget: false,
    cloneWaMessage: false,
    chatFollowupEnabled: false,
    chatFollowupDelayValue: "-5",
    chatFollowupDelayUnit: "minutes",
    chatFollowupInstructions: "",
    waFollowupEnabled: false,
    waFollowupDelayValue: "40",
    waFollowupDelayUnit: "days",
    waFollowupMessage: "",
    closingEnabled: false,
    closingDelayValue: "10",
    closingDelayUnit: "minutes",
    closingMessage: "",
    ...over,
  }) as ChannelRedirectFormState;

// The stored value under the typed unit could be out of range itself, so the pair goes back whole.
test("a hidden step's unit goes back with its value", () => {
  const out = edited(
    "followUp",
    { enabled: false, steps: [{ delayValue: 60, delayUnit: "days" }] },
    { steps: [{ delayValue: 60, delayUnit: "minutes" }] },
  );
  expect(out.steps).toEqual([{ delayValue: 60, delayUnit: "minutes" }]);
});

// A step stored with no delay reads as the default 60 minutes. Its unit typed to days and then hidden,
// the value is left out for that default, and the unit has to go with it or the step reads 60 days.
test("a hidden step with no stored delay drops the typed unit with the value", () => {
  const out = edited(
    "followUp",
    { enabled: false, steps: [{ delayValue: 60, delayUnit: "days" }] },
    { steps: [{ instructions: "" }] },
  );
  expect(out.steps).toEqual([{}]);
});

describe("a channel redirect saved with a follow-up off", () => {
  test("its out-of-range delay goes back as stored, the in-range ones as typed", () => {
    const out = fromChannelRedirectForm(form({}), {
      chatFollowupDelayValue: 30,
      waFollowupDelayValue: 3,
    });
    expect(out.chatFollowupDelayValue).toBe(30);
    expect(out.waFollowupDelayValue).toBe(3);
    expect(out.resendDelayValue).toBe(2);
    expect(out.closingDelayValue).toBe(10);
  });

  test("a hidden delay's unit goes back with its value", () => {
    const out = fromChannelRedirectForm(
      form({ chatFollowupDelayValue: "60", chatFollowupDelayUnit: "days" }),
      { chatFollowupDelayValue: 60, chatFollowupDelayUnit: "minutes" },
    );
    expect([out.chatFollowupDelayValue, out.chatFollowupDelayUnit]).toEqual([
      60,
      "minutes",
    ]);
  });

  test("with nothing stored, or no stored unit, the unit goes back as the default too", () => {
    const D = CHANNEL_REDIRECT_DEFAULTS;
    const fresh = fromChannelRedirectForm(
      form({ waFollowupDelayValue: "45", waFollowupDelayUnit: "days" }),
      undefined,
    );
    expect([fresh.waFollowupDelayValue, fresh.waFollowupDelayUnit]).toEqual([
      D.waFollowupDelayValue,
      D.waFollowupDelayUnit,
    ]);
    const noUnit = fromChannelRedirectForm(
      form({ waFollowupDelayValue: "45", waFollowupDelayUnit: "days" }),
      { waFollowupDelayValue: 45 },
    );
    expect([noUnit.waFollowupDelayValue, noUnit.waFollowupDelayUnit]).toEqual([
      45,
      D.waFollowupDelayUnit,
    ]);
  });

  test("with nothing stored the delay takes the default", () => {
    const out = fromChannelRedirectForm(form({ maxResends: "99" }), undefined);
    expect(out.chatFollowupDelayValue).toBe(
      CHANNEL_REDIRECT_DEFAULTS.chatFollowupDelayValue,
    );
    expect(out.maxResends).toBe(CHANNEL_REDIRECT_DEFAULTS.maxResends);
  });
});
