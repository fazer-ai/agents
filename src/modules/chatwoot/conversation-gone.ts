import { ChatwootApiError, type ChatwootClient } from "./client";

// Whether a read that failed did so because the conversation no longer exists in Chatwoot (deleted
// there), which no later read will change, as opposed to a timeout or a 5xx, which a later read may
// get past. A 404 alone is not enough: a proxy or a route this Chatwoot lacks answers 404 too, and a
// proxy that lost its route to Chatwoot answers 404 for every path. So the conversation itself has
// to answer 404 while the account it belongs to still answers: only then is Chatwoot the one saying
// the conversation is not there.
export async function conversationIsGone(
  client: Pick<ChatwootClient, "getConversation" | "getAccountName">,
  conversationId: number,
  err: unknown,
): Promise<boolean> {
  if (!(err instanceof ChatwootApiError) || err.status !== 404) return false;
  try {
    await client.getConversation(conversationId);
    return false;
  } catch (again) {
    if (!(again instanceof ChatwootApiError) || again.status !== 404)
      return false;
  }
  try {
    await client.getAccountName();
    return true;
  } catch {
    return false;
  }
}
