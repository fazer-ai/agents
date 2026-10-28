import { ChatwootApiError, type ChatwootClient } from "./client";

// Whether a read that failed did so because the conversation no longer exists in Chatwoot (deleted
// there), which no later read will change, as opposed to a timeout or a 5xx, which a later read may
// get past. A 404 alone is not enough: a proxy or a route this Chatwoot lacks answers 404 too, so the
// conversation itself is asked, and only its own 404 says it is gone.
export async function conversationIsGone(
  client: Pick<ChatwootClient, "getConversation">,
  conversationId: number,
  err: unknown,
): Promise<boolean> {
  if (!(err instanceof ChatwootApiError) || err.status !== 404) return false;
  try {
    await client.getConversation(conversationId);
    return false;
  } catch (again) {
    return again instanceof ChatwootApiError && again.status === 404;
  }
}
