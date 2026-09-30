// Its own module, not part of AuthContext: page tests replace
// "@/client/contexts/AuthContext" process-wide, so a helper living there
// cannot be tested reliably.
//
// Applies a saved change to the signed-in user only when it belongs to that
// same account. A save that lands after a sign-out and a sign-in as someone
// else must not rename the new account.
export function applyUserUpdate<T extends { id: string }>(
  current: T | null,
  userId: string,
  fields: Partial<T>,
): T | null {
  return current?.id === userId ? { ...current, ...fields } : current;
}
