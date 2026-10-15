import { describe, expect, test } from "bun:test";
import {
  groupSelection,
  matchingEvents,
  summarizeSubscription,
  toggleEvent,
  toggleGroup,
  type WebhookEventGroup,
} from "@/client/lib/webhookEventGroups";

// What a selection means per family: "all" is the family wildcard, and unchecking one event under it
// keeps the others explicitly. Every assertion reduces to a sorted list, a number or a boolean.

const docs: WebhookEventGroup = {
  family: "document",
  wildcard: "document.*",
  events: [
    "document.approval_requested",
    "document.approval_decided",
    "document.approval_outcome",
  ],
};
const system: WebhookEventGroup = {
  family: null,
  wildcard: null,
  events: ["heartbeat"],
};
const sorted = (s: Set<string>) => [...s].sort();

describe("the family's all box", () => {
  test("checking it stores the wildcard alone, dropping the names it covers", () => {
    const next = toggleGroup(
      new Set(["document.approval_decided", "heartbeat"]),
      docs,
    );
    expect(sorted(next)).toEqual(["document.*", "heartbeat"]);
  });

  test("unchecking it clears the family", () => {
    expect(
      sorted(toggleGroup(new Set(["document.*", "heartbeat"]), docs)),
    ).toEqual(["heartbeat"]);
  });

  test("three names checked one by one are not the wildcard, so the box still offers it", () => {
    const all = new Set(docs.events);
    expect(groupSelection(docs, all)).toEqual({
      wildcard: false,
      covered: 3,
      total: 3,
    });
    expect(sorted(toggleGroup(all, docs))).toEqual(["document.*"]);
  });

  test("a group with no wildcard toggles its names", () => {
    expect(sorted(toggleGroup(new Set(), system))).toEqual(["heartbeat"]);
    expect(sorted(toggleGroup(new Set(["heartbeat"]), system))).toEqual([]);
  });
});

describe("one event's box", () => {
  test("unchecking an event under the wildcard keeps the others, explicitly", () => {
    const next = toggleEvent(
      new Set(["document.*"]),
      docs,
      "document.approval_outcome",
    );
    expect(sorted(next)).toEqual([
      "document.approval_decided",
      "document.approval_requested",
    ]);
  });

  test("unchecking under the wildcard drops the name too when it was stored beside it", () => {
    const next = toggleEvent(
      new Set(["document.*", "document.approval_outcome"]),
      docs,
      "document.approval_outcome",
    );
    expect(sorted(next)).toEqual([
      "document.approval_decided",
      "document.approval_requested",
    ]);
  });

  test("outside the wildcard it toggles that name only", () => {
    const on = toggleEvent(new Set(), docs, "document.approval_decided");
    expect(sorted(on)).toEqual(["document.approval_decided"]);
    expect(sorted(toggleEvent(on, docs, "document.approval_decided"))).toEqual(
      [],
    );
  });
});

describe("the summary of a stored subscription", () => {
  test("names each family it touches, with all or N of M, and keeps a name the catalog lost", () => {
    const conv: WebhookEventGroup = {
      family: "conversation",
      wildcard: "conversation.*",
      events: ["conversation.created", "conversation.handoff"],
    };
    const s = summarizeSubscription(
      [
        "conversation.*",
        "document.approval_requested",
        "document.approval_decided",
        "gone.event",
      ],
      [conv, docs, system],
    );
    expect(
      s.groups.map((g) => [
        g.group.family,
        g.selection.wildcard,
        g.selection.covered,
        g.selection.total,
      ]),
    ).toEqual([
      ["conversation", true, 2, 2],
      ["document", false, 2, 3],
    ]);
    expect(s.unknown).toEqual(["gone.event"]);
  });
});

describe("the search", () => {
  const label = (e: string) =>
    ({
      "document.approval_requested": "Approval requested",
      "document.approval_decided": "Approval decided",
      "document.approval_outcome": "Final result",
    })[e] ?? e;

  test("matches the label or the raw name, case-insensitively", () => {
    expect(matchingEvents(docs, "DECIDED", label, "Documents")).toEqual([
      "document.approval_decided",
    ]);
    expect(
      matchingEvents(docs, "approval_outcome", label, "Documents"),
    ).toEqual(["document.approval_outcome"]);
  });

  test("a label that shares no word with the raw name still matches", () => {
    expect(matchingEvents(docs, "final", label, "Documents")).toEqual([
      "document.approval_outcome",
    ]);
  });

  test("a match on the family keeps all its events, and an empty query keeps everything", () => {
    expect(matchingEvents(docs, "docum", label, "Documents")).toHaveLength(3);
    expect(matchingEvents(docs, "  ", label, "Documents")).toHaveLength(3);
    expect(matchingEvents(docs, "nothing", label, "Documents")).toEqual([]);
  });
});
