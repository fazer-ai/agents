import { describe, expect, test } from "bun:test";
import {
  type ConversationOutcome,
  type ConversationOutcomeRow,
  classifyOutcome,
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
