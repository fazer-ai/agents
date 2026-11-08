// Shared test-mode gate predicate (item 16). A "test" agent stays silent in a conversation until the
// customer activates it with /teste (which stamps Conversation.testActivatedAt). This is the single
// source of truth for "is this conversation currently silenced", used by the webhook gate, the
// follow-up handlers, and proactive nudges so NONE of them act on an unactivated test conversation.
//
// Pure: mode is Agent.mode ("test" | "production" | "monitoring"), testActivatedAt is the conversation's activation
// timestamp (null = not activated). Production agents are never silenced.
export function isTestSilenced(
  mode: string,
  testActivatedAt: Date | null,
): boolean {
  return mode === "test" && testActivatedAt === null;
}

// Whether a `/reset` should actually run its wipe (memory + prefs + labels + card dates). /reset only
// applies once test mode is ACTIVE for the conversation (a /teste was sent). A /reset typed BEFORE
// activation must NOT wipe anything AND must NOT cause the agent to answer — the caller defers it to
// the test-mode gate, which silences the conversation (see isTestSilenced). This is exactly the
// complement of "still silenced": shouldRunReset is true only when the conversation is a test one that
// has been activated. Pure; mirrors isTestSilenced's inputs.
export function shouldRunReset(
  mode: string,
  testActivatedAt: Date | null,
): boolean {
  return mode === "test" && testActivatedAt !== null;
}

// A conversation the test-mode silence opened for the team ("parked"): Chatwoot starts it `pending` on
// a bot inbox, a tab the team does not watch, and the silenced agent would never answer it, so the
// gate moves it to `open` and records the holder Chatwoot assigned in that same write (its own
// auto-assignment, or nobody). Any other person assigned afterwards took it from there, and the
// mirror ends the park when it writes one (`endsTestPark`).
export interface TestPark {
  parkedAt: Date | null;
  parkedAssigneeId: number | null;
}

// Whether a mirrored assignee write ends the park: a person other than the one the park itself got.
// A bot, or nobody, is not someone taking the conversation.
export function endsTestPark(
  park: TestPark,
  next: { assigneeType: string | null; assigneeId: number | null },
): boolean {
  return (
    park.parkedAt !== null &&
    next.assigneeType === "User" &&
    next.assigneeId !== park.parkedAssigneeId
  );
}

// Whether /teste may give the conversation back to the agent: still parked, still `open`, and held by
// nobody or by the person the park itself got. Anything else is somebody's conversation, and /teste
// keeps saying so and naming /reset.
export function testParkHolds(
  park: TestPark,
  live: {
    status: string;
    assigneeType: string | null;
    assigneeId: number | null;
  },
): boolean {
  if (park.parkedAt === null || live.status !== "open") return false;
  if (live.assigneeType === null) return true;
  return (
    live.assigneeType === "User" && live.assigneeId === park.parkedAssigneeId
  );
}
