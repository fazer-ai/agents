import { describe, expect, test } from "bun:test";
import {
  type ConversationOutcome,
  type ConversationOutcomeRow,
  classifyOutcome,
  clearsResolutionOrigin,
  isResolutionOrigin,
  RESOLUTION_ORIGINS,
} from "@/modules/conversations/resolution-origin";

describe("classifyOutcome", () => {
  // Decision table. Every row is a closing the dashboard can actually receive; the `expected`
  // column is what the Resolution funnel is allowed to make of it.
  const cases: [
    name: string,
    row: ConversationOutcomeRow,
    expected: ConversationOutcome,
  ][] = [
    [
      "the agent resolved it itself",
      { status: "resolved", assigneeType: null, resolvedBy: "agent" },
      "resolved_by_agent",
    ],
    [
      "the agent resolved it while the bot was still the assignee",
      { status: "resolved", assigneeType: "AgentBot", resolvedBy: "agent" },
      "resolved_by_agent",
    ],
    [
      "the abandonment step of a follow-up closed a lead that never answered",
      {
        status: "resolved",
        assigneeType: null,
        resolvedBy: "followup_abandonment",
      },
      "resolved_by_other",
    ],
    [
      "the channel-redirect ladder tidied up the conversation it moved away from",
      {
        status: "resolved",
        assigneeType: null,
        resolvedBy: "redirect_closing",
      },
      "resolved_by_other",
    ],
    [
      "an operator resolved it from the console",
      { status: "resolved", assigneeType: null, resolvedBy: "console" },
      "resolved_by_other",
    ],
    [
      // Chatwoot's own auto_resolve_after, an automation rule, or an operator resolving in the
      // Chatwoot UI without assigning themselves. None of them reach our code, so nothing was
      // recorded — and an unattributed closing is not the agent's.
      "something outside our code resolved it",
      { status: "resolved", assigneeType: null, resolvedBy: null },
      "resolved_by_other",
    ],
    [
      "it was already resolved when the origin started being recorded",
      { status: "resolved", assigneeType: null, resolvedBy: "legacy_unknown" },
      "resolved_before_tracking",
    ],
    [
      "a human took it over",
      { status: "resolved", assigneeType: "User", resolvedBy: null },
      "handoff",
    ],
    [
      "a human took it over after the agent had asked to resolve",
      { status: "resolved", assigneeType: "User", resolvedBy: "agent" },
      "handoff",
    ],
    [
      "a human owns it and it is still open",
      { status: "open", assigneeType: "User", resolvedBy: null },
      "handoff",
    ],
    [
      "still open",
      { status: "open", assigneeType: null, resolvedBy: null },
      "unresolved",
    ],
    [
      "pending",
      { status: "pending", assigneeType: "AgentBot", resolvedBy: null },
      "unresolved",
    ],
    [
      // The stamp survives a reopen only if the mirror failed to clear it. It must not count: the
      // conversation is not resolved, so there is no resolution to attribute.
      "reopened while still carrying the agent's stamp",
      { status: "open", assigneeType: null, resolvedBy: "agent" },
      "unresolved",
    ],
  ];

  for (const [name, row, expected] of cases) {
    test(name, () => {
      expect(classifyOutcome(row)).toBe(expected);
    });
  }

  test("only the agent's own closing counts as a resolution", () => {
    const counted = RESOLUTION_ORIGINS.filter(
      (origin) =>
        classifyOutcome({
          status: "resolved",
          assigneeType: null,
          resolvedBy: origin,
        }) === "resolved_by_agent",
    );
    expect(counted).toEqual(["agent"]);
  });
});

describe("clearsResolutionOrigin", () => {
  // Decision table over the three facts every status writer has: what the row says, what the source
  // says, and what the ordering decided to write. Six review rounds of this change were six wrong
  // ways to ask this question inline; the point of the table is that a seventh cannot be added
  // anywhere else.
  const cases: [
    name: string,
    source: Parameters<typeof clearsResolutionOrigin>[0],
    expected: boolean,
  ][] = [
    [
      "a winning reopen over a resolved row ends the resolution",
      {
        storedStatus: "resolved",
        statedStatus: "open",
        appliedStatus: "open",
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      true,
    ],
    [
      "a reopen that LOST the ordering leaves the row resolved and the origin standing",
      {
        storedStatus: "resolved",
        statedStatus: "open",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      false,
    ],
    [
      "our close losing to a reopen drops the stamp it wrote ahead of its own event",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      true,
    ],
    [
      "our close landing keeps it",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: "resolved",
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      false,
    ],
    [
      "an unrelated event writing the SAME non-resolved status is not a reopen",
      {
        storedStatus: "open",
        statedStatus: "open",
        appliedStatus: "open",
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      false,
    ],
    [
      "an event that states no status decides nothing",
      {
        storedStatus: "open",
        statedStatus: null,
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      false,
    ],
    [
      "a frozen message snapshot saying 'resolved' is not a close that lost (issue #61)",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: false,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      false,
    ],
    [
      "the reopen a new incoming message carries faithfully still ends the resolution",
      {
        storedStatus: "resolved",
        statedStatus: "open",
        appliedStatus: "open",
        sourceMayStateStatus: false,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      true,
    ],
    [
      "a duplicate old close on an already-resolved row says nothing about the stamp",
      {
        storedStatus: "resolved",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      false,
    ],
    [
      "leaving 'resolved' for 'pending' is a leave like any other",
      {
        storedStatus: "resolved",
        statedStatus: "pending",
        appliedStatus: "pending",
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      true,
    ],
    [
      "a close arriving over a row already held resolved keeps the earlier origin",
      {
        storedStatus: "resolved",
        statedStatus: "resolved",
        appliedStatus: "resolved",
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      false,
    ],
    [
      "a snapshot that may not state status cannot reopen on its word alone",
      {
        storedStatus: "pending",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: false,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      false,
    ],
    [
      "a delayed close from an EARLIER episode leaves a newer stamp alone",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: 99,
        stampedAfterVersion: 100,
      },
      false,
    ],
    [
      "a claim exactly at the floor is the episode the stamp came after, not this one",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: 100,
        stampedAfterVersion: 100,
      },
      false,
    ],
    [
      "our own close, newer than the floor, still clears when it loses",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: 101,
        stampedAfterVersion: 100,
      },
      true,
    ],
    [
      "no floor recorded means nothing to compare, so the rule keeps its unprotected form",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: 99,
        stampedAfterVersion: null,
      },
      true,
    ],
    [
      "a versionless claim cannot be placed against a floor either",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: 100,
      },
      true,
    ],
    [
      "the floor does not protect a stamp on a conversation that LEFT resolved",
      {
        storedStatus: "resolved",
        statedStatus: "open",
        appliedStatus: "open",
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: 50,
        stampedAfterVersion: 100,
      },
      true,
    ],
    [
      "a customer coming back ends the episode even if we never saw the close land",
      {
        storedStatus: "open",
        statedStatus: "open",
        appliedStatus: "open",
        sourceMayStateStatus: false,
        reopens: true,
        statedVersion: 120,
        stampedAfterVersion: 100,
      },
      true,
    ],
    [
      "a RETRIED delivery of the message that opened this episode is not a new reopen",
      {
        storedStatus: "open",
        statedStatus: "open",
        appliedStatus: "open",
        sourceMayStateStatus: false,
        reopens: true,
        statedVersion: 100,
        stampedAfterVersion: 100,
      },
      false,
    ],
    [
      "a reopen landing on a row that stays resolved decides nothing here",
      {
        storedStatus: "resolved",
        statedStatus: "resolved",
        appliedStatus: "resolved",
        sourceMayStateStatus: true,
        reopens: true,
        statedVersion: 120,
        stampedAfterVersion: 100,
      },
      false,
    ],
    [
      "KNOWN LIMIT: with no versions anywhere the floor cannot protect anything",
      {
        storedStatus: "open",
        statedStatus: "resolved",
        appliedStatus: null,
        sourceMayStateStatus: true,
        reopens: false,
        statedVersion: null,
        stampedAfterVersion: null,
      },
      true,
    ],
  ];

  for (const [name, source, expected] of cases) {
    test(name, () => {
      expect(clearsResolutionOrigin(source)).toBe(expected);
    });
  }
});

describe("isResolutionOrigin", () => {
  test("accepts every recorded origin", () => {
    for (const origin of RESOLUTION_ORIGINS) {
      expect(isResolutionOrigin(origin)).toBe(true);
    }
  });

  test("rejects anything else", () => {
    for (const v of [null, undefined, "", "AGENT", "bot", 1, {}]) {
      expect(isResolutionOrigin(v)).toBe(false);
    }
  });
});
