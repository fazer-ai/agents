import { describe, expect, test } from "bun:test";
import {
  type FollowUpLiveness,
  isFollowUpLive,
} from "@/modules/followups/eligibility";

// Decision table: one row per reason the handler drops a claimed follow-up job. The console indicator
// reads the same predicate, so a row that flips here flips in both places at once — which is the
// whole point of the predicate existing (issue #72).

const LIVE: FollowUpLiveness = {
  agentEnabled: true,
  followUpEnabled: true,
  managedByRedirect: false,
  agentMode: "production",
  testActivatedAt: null,
  status: "pending",
  assigneeType: null,
};

const cases: Array<{
  name: string;
  patch: Partial<FollowUpLiveness>;
  live: boolean;
}> = [
  { name: "nothing in the way", patch: {}, live: true },
  {
    name: "the agent is disabled",
    patch: { agentEnabled: false },
    live: false,
  },
  {
    name: "follow-up is switched off",
    patch: { followUpEnabled: false },
    live: false,
  },
  {
    name: "a channelRedirect owns re-engagement",
    patch: { managedByRedirect: true },
    live: false,
  },
  {
    name: "a test agent whose conversation was never activated",
    patch: { agentMode: "test" },
    live: false,
  },
  {
    name: "a test agent whose conversation WAS activated",
    patch: { agentMode: "test", testActivatedAt: new Date() },
    live: true,
  },
  {
    name: "a human took the conversation",
    patch: { assigneeType: "User" },
    live: false,
  },
  {
    name: "the conversation was resolved",
    patch: { status: "resolved" },
    live: false,
  },
  {
    name: "the conversation was reopened but is not pending",
    patch: { status: "open" },
    live: false,
  },
  {
    // Without the instance bot id there is no way to tell OUR bot from another one; the handler
    // and the estimate both call shouldBotHandle without it, so this stays live in both.
    name: "a bot holds it",
    patch: { assigneeType: "AgentBot" },
    live: true,
  },
];

describe("isFollowUpLive", () => {
  for (const c of cases) {
    test(`${c.live ? "live" : "dead"}: ${c.name}`, () => {
      expect(isFollowUpLive({ ...LIVE, ...c.patch })).toBe(c.live);
    });
  }
});
