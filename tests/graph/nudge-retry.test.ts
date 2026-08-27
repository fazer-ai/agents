import { describe, expect, test } from "bun:test";
import {
  type AgentNudge,
  nudgeOccasionKey,
  type RunAgentNudgeOutcome,
} from "@/graph/nudge";
import {
  isRepairableNudgeRefusal,
  NUDGE_RETRY_BACKOFF_MS,
  NUDGE_RETRY_LIMIT,
  nextNudgeRetry,
} from "@/graph/nudge-retry";

// Every outcome `runAgentNudge` can answer, and whether a caller that owns an occasion may spend it.
// The `false` rows are the design decision, not filler: the two that mean "there is nothing here to
// preserve", the one that means the conversation stopped being ours, and the three that mean the
// agent DID take its turn.
const TABLE: Array<[RunAgentNudgeOutcome, boolean]> = [
  ["agent-unavailable", true],
  ["live-unavailable", true],
  ["deferred", true],
  // The month turns over on its own, and the operator can raise the number before it does. Spending
  // the occasion immediately would lose a follow-up nobody resends. What it buys is BOUNDED by this
  // ladder, which is the same one `agent-unavailable` rides: 8 attempts, 15 minutes apart, so a
  // ceiling still standing two hours later spends the occasion anyway. That is the common case
  // covered, not a promise that the occasion waits for the month to turn (issue #146).
  ["over-ceiling", true],
  ["messaged", false],
  ["templated", false],
  ["noted", false],
  ["noted-window", false],
  ["silent", false],
  ["stale", false],
  ["no-conversation", false],
  ["no-agent", false],
];

describe("isRepairableNudgeRefusal", () => {
  for (const [outcome, repairable] of TABLE) {
    test(`${outcome} → ${repairable ? "retry the occasion" : "spend the occasion"}`, () => {
      expect(isRepairableNudgeRefusal(outcome)).toBe(repairable);
    });
  }

  // The fence that makes the table above a decision instead of a snapshot: an outcome added to the
  // union without a row here fails this test rather than silently defaulting to "spend it", which is
  // the answer that costs a customer a message. Reads the union from source because a type union has
  // no runtime form to enumerate.
  test("covers every member of the outcome union, and no invented one", async () => {
    const src = await Bun.file("src/graph/nudge.ts").text();
    // Ends at the first quote-then-semicolon that closes a line: the prose between members carries
    // semicolons of its own, and slicing at the first one reads half a union as the whole of it.
    const body = src
      .slice(src.indexOf("export type RunAgentNudgeOutcome"))
      .match(/^[\s\S]*?"\s*;\s*$/m)?.[0];
    expect(body).toBeTruthy();
    const declared = new Set(
      [...(body ?? "").matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual(TABLE.map(([o]) => o).sort());
  });
});

describe("nextNudgeRetry", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");

  test("a first refusal schedules one backoff away and counts as attempt 1", () => {
    const d = nextNudgeRetry({}, now);
    expect(d).toEqual({
      retry: true,
      attempt: 1,
      runAt: new Date(now.getTime() + NUDGE_RETRY_BACKOFF_MS),
    });
  });

  test("the counter rides in the payload and advances by one", () => {
    const d = nextNudgeRetry({ nudgeRetries: 3 }, now);
    expect(d.retry).toBe(true);
    expect(d.attempt).toBe(4);
  });

  test("the last allowed attempt still retries", () => {
    const d = nextNudgeRetry({ nudgeRetries: NUDGE_RETRY_LIMIT - 2 }, now);
    expect(d.retry).toBe(true);
    expect(d.attempt).toBe(NUDGE_RETRY_LIMIT - 1);
  });

  test("the bound is reached, and the occasion is given up rather than retried", () => {
    const d = nextNudgeRetry({ nudgeRetries: NUDGE_RETRY_LIMIT - 1 }, now);
    expect(d).toEqual({ retry: false, attempt: NUDGE_RETRY_LIMIT });
  });

  // A payload is JSON a previous run wrote, so it can hold anything. The negative is the one that
  // matters: read as itself it would push the ceiling out of reach and retry forever, which is the
  // single failure the bound exists to prevent.
  for (const bad of [-5, 0, 1.5, "3", null, undefined, {}]) {
    test(`a payload counter of ${JSON.stringify(bad)} reads as none`, () => {
      expect(nextNudgeRetry({ nudgeRetries: bad }, now).attempt).toBe(1);
    });
  }
});

// WHICH SCHEDULED OCCASION A REFUSAL BELONGS TO, proved without a database. The `over` line the
// ceiling writes is one per occasion, and the retry ladder is only half of what that has to mean:
// the same conversation carries independent jobs, and collapsing them loses the second one's row and
// its alert entirely.
describe("the occasion a nudge refusal belongs to", () => {
  const key = (nudge: AgentNudge) => nudgeOccasionKey(77, nudge);

  test("the same job asked twice is one occasion", () => {
    const job = { source: "followup", kind: "inactivity", step: 2 };
    expect(key(job)).toBe(key({ ...job }));
  });

  test.each([
    [
      "a different source",
      { source: "appointment_reminder", kind: "inactivity", step: 2 },
    ],
    ["a different kind", { source: "followup", kind: "resolved", step: 2 }],
    ["a different step", { source: "followup", kind: "inactivity", step: 3 }],
  ])("%s is a different occasion", (_name, other) => {
    expect(key({ source: "followup", kind: "inactivity", step: 2 })).not.toBe(
      key(other),
    );
  });

  // Two reminders for two appointments on one conversation, which is an ordinary shape for a clinic.
  test("two appointments are two occasions", () => {
    const reminder = (eventId: string) => ({
      source: "appointment_reminder",
      kind: "reminder",
      refs: { event_id: eventId, calendar_id: "cal-1" },
    });
    expect(key(reminder("evt-1"))).not.toBe(key(reminder("evt-2")));
  });

  // The key is a string built on whatever machine runs the job, so its parts cannot depend on
  // insertion order or on a locale's collation.
  test("the refs order does not change the key", () => {
    const a = {
      source: "appointment_reminder",
      refs: { event_id: "e", calendar_id: "c" },
    };
    const b = {
      source: "appointment_reminder",
      refs: { calendar_id: "c", event_id: "e" },
    };
    expect(key(a)).toBe(key(b));
  });

  // The parts are separated unambiguously, which `k=v` joined by commas is not: refs are opaque
  // strings from somebody else's calendar, and one carrying the delimiters would otherwise collide
  // with a different set of refs entirely.
  test("a ref that contains the delimiters is not a different occasion's key", () => {
    const source = "appointment_reminder";
    expect(key({ source, refs: { a: "x,b=y" } })).not.toBe(
      key({ source, refs: { a: "x", b: "y" } }),
    );
  });

  // And the conversation is still part of it: two tenants' worth of identical jobs must not share a
  // window.
  test("the conversation is part of the identity", () => {
    const job = { source: "followup", kind: "inactivity", step: 1 };
    expect(nudgeOccasionKey(77, job)).not.toBe(nudgeOccasionKey(78, job));
  });
});
