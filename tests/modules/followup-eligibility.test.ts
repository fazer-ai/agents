import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  mirrorHolder: "ours",
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
    // Attribution alone cannot tell OUR bot from another one, which is why the holder is an input:
    // a reader that only knows "an AgentBot has it" has not answered the question.
    name: "a bot holds it and the reader says it is ours",
    patch: { assigneeType: "AgentBot" },
    live: true,
  },
  // ── The ownership axis (issue #214). The same conversation is live or dead depending on what the
  //    READER can say about the holder, which is the divergence the predicate now carries explicitly
  //    instead of leaving each reader to build its own gate.
  {
    name: "the mirror names another party's bot, or one it cannot identify",
    patch: { assigneeType: "AgentBot", mirrorHolder: "not-ours" },
    live: false,
  },
  {
    // The handler's value: it re-asks Chatwoot before sending, so refusing on a stale assignee here
    // would drop a follow-up the probe was about to allow.
    name: "the reader does not decide ownership from the mirror",
    patch: { assigneeType: "AgentBot", mirrorHolder: "not-asked" },
    live: true,
  },
  {
    // "not-ours" never RESCUES a row the other terms already refuse, and never overrides them:
    // every other reason to be dead stays dead whatever the holder is.
    name: "somebody else holds it AND the agent is disabled",
    patch: { agentEnabled: false, mirrorHolder: "not-ours" },
    live: false,
  },
  {
    // The human case answered on the ownership axis instead of the assignee one: still dead, and by
    // two independent terms, so neither reader depends on the other being right.
    name: "a human holds it, reported on the holder axis too",
    patch: { assigneeType: "User", mirrorHolder: "not-ours" },
    live: false,
  },
];

describe("isFollowUpLive", () => {
  for (const c of cases) {
    test(`${c.live ? "live" : "dead"}: ${c.name}`, () => {
      expect(isFollowUpLive({ ...LIVE, ...c.patch })).toBe(c.live);
    });
  }
});

// `mirrorHolder: "not-asked"` reads as live, so it is only sound for a reader that re-asks Chatwoot
// before it sends. The decision table above proves what the predicate DOES with each value; it cannot
// prove that the readers pass the value they are entitled to, and picking "not-asked" is what a new
// reader does when the strict answer is inconvenient — which is issue #214 all over again, silently.
//
// A file-scoped check, and deliberately no stronger: it says the abstaining file also arms the live
// probe, not that the two are on the same branch. That is enough to make a copy-paste into a reader
// with no probe fail here and be read about.
describe('mirrorHolder: "not-asked" — who may say it', () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
    return out;
  }

  test("every reader that abstains re-asks Chatwoot before sending", () => {
    const abstaining = sourceFiles("src").filter((f) =>
      readFileSync(f, "utf8").includes('mirrorHolder: "not-asked"'),
    );
    // The handler is the one reader entitled to it today; zero matches would mean the check went
    // stale (the string moved or was renamed) rather than that the rule holds.
    expect(abstaining).toEqual(["src/modules/followups/handlers.ts"]);
    for (const f of abstaining) {
      expect(readFileSync(f, "utf8")).toContain(
        "requireLiveBotOwnership: true",
      );
    }
  });
});
