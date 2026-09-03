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
