import { describe, expect, test } from "bun:test";
import {
  consoleWriteLandedAfter,
  consoleWriteMark,
} from "@/modules/chatwoot/console-write-order";
import { parseLiveConversation } from "@/modules/chatwoot/normalize";

// The decision this whole issue turns on, as a table (issue #469). Two coordinates, and the pair of
// nulls is not one case: a missing mark and a missing trigger are different facts that both have to
// answer "do not refuse", and a single null-check would collapse them into one branch that a
// mutation cannot tell apart.
describe("consoleWriteLandedAfter", () => {
  const CASES: {
    name: string;
    trigger: number | null;
    mark: number | null;
    expected: boolean;
  }[] = [
    {
      name: "a reply that already existed when the operator clicked",
      trigger: 100,
      mark: 100,
      expected: true,
    },
    {
      name: "a reply older than the click",
      trigger: 99,
      mark: 100,
      expected: true,
    },
    {
      name: "a reply typed AFTER the click — a real handover, never skipped",
      trigger: 101,
      mark: 100,
      expected: false,
    },
    {
      name: "no console write has been made unversioned on this row",
      trigger: 100,
      mark: null,
      expected: false,
    },
    {
      name: "a caller that named no message has nothing to order",
      trigger: null,
      mark: 100,
      expected: false,
    },
    {
      name: "neither side names anything",
      trigger: null,
      mark: null,
      expected: false,
    },
    {
      name: "id 0 is a number, not an absence",
      trigger: 0,
      mark: 0,
      expected: true,
    },
    // The pair that says the null-check is a check and not decoration: `0 <= null` is `0 <= 0` in
    // JavaScript, so without it the lowest possible id would be refused by a row that carries no
    // mark at all. The mutation that drops the guard survives every other row in this table.
    {
      name: "id 0 against no mark is still no evidence",
      trigger: 0,
      mark: null,
      expected: false,
    },
  ];

  for (const c of CASES) {
    test(c.name, () => {
      expect(consoleWriteLandedAfter(c.trigger, c.mark)).toBe(c.expected);
    });
  }
});

describe("consoleWriteMark", () => {
  test("a read that named a message stamps it", () => {
    expect(consoleWriteMark({ latestMessageId: 512 })).toBe(512);
  });

  test("a read that failed stamps nothing", () => {
    expect(consoleWriteMark(null)).toBeNull();
  });

  test("a read that named no message stamps nothing", () => {
    expect(consoleWriteMark({ latestMessageId: null })).toBeNull();
  });
});

// The other half: the mark is only as good as what the parser reads off a real payload. The shapes
// below are the ones the fork's `_conversation.json.jbuilder` renders, measured on 4.17.0.
describe("parseLiveConversation reads the source's message sequence", () => {
  const conv = (extra: Record<string, unknown>) => ({
    id: 7,
    status: "pending",
    meta: {},
    ...extra,
  });

  test("the REST show's one-element `messages` array (dashboard_seed_message)", () => {
    expect(
      parseLiveConversation(conv({ messages: [{ id: 64448 }] }))
        ?.latestMessageId,
    ).toBe(64448);
  });

  test("`last_non_activity_message` alone", () => {
    expect(
      parseLiveConversation(conv({ last_non_activity_message: { id: 900 } }))
        ?.latestMessageId,
    ).toBe(900);
  });

  // The two disagree exactly when the newest message IS an activity line, and the answer has to be
  // the newest one the source has — otherwise the mark sits below a message that already exists and
  // the fence lets that message through.
  test("the HIGHEST of the two, whichever list holds it", () => {
    expect(
      parseLiveConversation(
        conv({
          messages: [{ id: 950 }],
          last_non_activity_message: { id: 900 },
        }),
      )?.latestMessageId,
    ).toBe(950);
    expect(
      parseLiveConversation(
        conv({
          messages: [{ id: 900 }],
          last_non_activity_message: { id: 950 },
        }),
      )?.latestMessageId,
    ).toBe(950);
  });

  // Not leniency for its own sake: `num` takes both spellings because Chatwoot has two serializers
  // that disagree about them (the same reason `message_type` is read both ways), so a digit string
  // here is the id, not a malformed payload.
  test("an id serialized as a digit string is still that id", () => {
    expect(
      parseLiveConversation(conv({ messages: [{ id: "64448" }] }))
        ?.latestMessageId,
    ).toBe(64448);
  });

  test("more than one entry in `messages` still yields the newest", () => {
    expect(
      parseLiveConversation(
        conv({ messages: [{ id: 10 }, { id: 42 }, { id: 30 }] }),
      )?.latestMessageId,
    ).toBe(42);
  });

  // Every degraded shape names NO message rather than inventing one: the mark may only ever be too
  // low, and a number read out of a malformed payload is the one direction that costs a takeover.
  const DEGRADED: [string, Record<string, unknown>][] = [
    ["no message keys at all", {}],
    ["an empty list", { messages: [] }],
    ["a null preview", { last_non_activity_message: null }],
    ["a list of non-records", { messages: ["nope", 3, null] }],
    ["entries with no id", { messages: [{ content: "hi" }] }],
    [
      "an id that is neither a number nor digits",
      { messages: [{ id: "abc" }] },
    ],
    ["`messages` that is not a list", { messages: { id: 5 } }],
  ];
  for (const [name, extra] of DEGRADED) {
    test(`names no message: ${name}`, () => {
      expect(parseLiveConversation(conv(extra))?.latestMessageId).toBeNull();
    });
  }
});
